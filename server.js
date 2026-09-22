const express = require("express");
const cheerio = require("cheerio");
const dns = require("dns").promises;
const net = require("net");

const app = express();
const PORT = process.env.PORT || 3000;

// Serve the Hollowsoft portal
app.use(express.static("."));


// ========================================
// Unified search
// ========================================

app.get("/go", (req, res) => {
    const input = (req.query.q || "").trim();

    if (!input) {
        return res.redirect("/");
    }

    let destination;

    if (
        /^https?:\/\//i.test(input) ||
        /^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(input)
    ) {
        destination = /^https?:\/\//i.test(input)
            ? input
            : "https://" + input;
    } else {
        destination =
            "https://www.google.com/search?q=" +
            encodeURIComponent(input);
    }

    res.redirect(
        "/proxy?url=" + encodeURIComponent(destination)
    );
});


// ========================================
// Proxy
// ========================================

app.get("/proxy", async (req, res) => {
    const target = req.query.url;

    if (!target) {
        return res.status(400).send("Missing URL.");
    }

    let targetURL;

    try {
        targetURL = new URL(target);
    } catch {
        return res.status(400).send("Invalid URL.");
    }

    if (
        targetURL.protocol !== "http:" &&
        targetURL.protocol !== "https:"
    ) {
        return res.status(400).send("Only HTTP and HTTPS are supported.");
    }

    // Basic protection against accidentally turning Hollowsoft
    // into a proxy for local/private network addresses.
    try {
        const addresses = await dns.lookup(targetURL.hostname, {
            all: true
        });

        for (const address of addresses) {
            if (isPrivateAddress(address.address)) {
                return res.status(403).send(
                    "Access to private network addresses is not allowed."
                );
            }
        }
    } catch {
        return res.status(502).send("Could not resolve the target host.");
    }

    try {
        const response = await fetch(targetURL, {
            redirect: "follow",
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
                    "AppleWebKit/537.36 (KHTML, like Gecko) " +
                    "Chrome/140 Safari/537.36",
                "Accept":
                    "text/html,application/xhtml+xml," +
                    "application/xml;q=0.9,*/*;q=0.8"
            }
        });

        const finalURL = new URL(response.url);
        const contentType =
            response.headers.get("content-type") || "";

        // Non-HTML resources
        if (!contentType.toLowerCase().includes("text/html")) {
            const data = Buffer.from(
                await response.arrayBuffer()
            );

            res.status(response.status);
            res.set("Content-Type", contentType);

            return res.send(data);
        }

        const html = await response.text();
        const $ = cheerio.load(html);

        // --------------------------------
        // Rewrite normal links
        // --------------------------------

        $("a[href]").each((_, element) => {
            rewriteAttribute(
                $,
                element,
                "href",
                finalURL
            );
        });


        // --------------------------------
        // Rewrite images
        // --------------------------------

        $("img[src]").each((_, element) => {
            rewriteAttribute(
                $,
                element,
                "src",
                finalURL
            );
        });


        // --------------------------------
        // Rewrite scripts
        // --------------------------------

        $("script[src]").each((_, element) => {
            rewriteAttribute(
                $,
                element,
                "src",
                finalURL
            );
        });


        // --------------------------------
        // Rewrite CSS
        // --------------------------------

        $("link[href]").each((_, element) => {
            rewriteAttribute(
                $,
                element,
                "href",
                finalURL
            );
        });


        // --------------------------------
        // Rewrite media
        // --------------------------------

        $("video[src], audio[src], source[src]").each(
            (_, element) => {
                rewriteAttribute(
                    $,
                    element,
                    "src",
                    finalURL
                );
            }
        );


        // --------------------------------
        // Rewrite iframes
        // --------------------------------

        $("iframe[src]").each((_, element) => {
            rewriteAttribute(
                $,
                element,
                "src",
                finalURL
            );
        });


        // --------------------------------
        // Rewrite forms
        // --------------------------------

        $("form[action]").each((_, element) => {
            rewriteAttribute(
                $,
                element,
                "action",
                finalURL
            );
        });


        // --------------------------------
        // Rewrite CSS url(...)
        // --------------------------------

        $("style").each((_, element) => {
            let css = $(element).html();

            if (!css) return;

            css = rewriteCSSUrls(css, finalURL);

            $(element).html(css);
        });


        // --------------------------------
        // Navigation helper
        //
        // This handles normal client-side
        // pushState/replaceState navigation
        // without using a <base> element.
        // --------------------------------

        const navigationScript = `
<script>
(function() {
    const proxyPrefix = "/proxy?url=";

    function proxyURL(url) {
        try {
            const absolute = new URL(url, ${JSON.stringify(finalURL.href)});

            if (
                absolute.protocol !== "http:" &&
                absolute.protocol !== "https:"
            ) {
                return;
            }

            const current = new URL(window.location.href);

            // If the target is already a Hollowsoft proxy URL,
            // don't proxy it again.
            if (
                current.pathname === "/proxy" &&
                absolute.href === current.searchParams.get("url")
            ) {
                return;
            }

            window.location.href =
                proxyPrefix +
                encodeURIComponent(absolute.href);
        } catch (error) {
            console.error("Hollowsoft navigation error:", error);
        }
    }

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function(state, title, url) {
        if (url) {
            proxyURL(url);
            return;
        }

        return originalPushState.apply(
            history,
            arguments
        );
    };

    history.replaceState = function(state, title, url) {
        if (url) {
            proxyURL(url);
            return;
        }

        return originalReplaceState.apply(
            history,
            arguments
        );
    };
})();
</script>
`;

        $("body").append(navigationScript);


        // --------------------------------
        // Return page
        // --------------------------------

        res.status(response.status);

        res.set(
            "Content-Type",
            "text/html; charset=utf-8"
        );

        res.send($.html());

    } catch (error) {
        console.error("Hollowsoft proxy error:", error);

        res.status(502).send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Hollowsoft Proxy Error</title>

    <style>
        body {
            margin: 0;
            padding: 50px;
            background: #111;
            color: white;
            font-family: Arial, sans-serif;
            text-align: center;
        }

        h1 {
            font-size: 32px;
        }

        p {
            color: #aaa;
        }

        code {
            color: #fff;
        }
    </style>
</head>

<body>
    <h1>Hollowsoft couldn't load that page.</h1>

    <p>
        The target website rejected the request or could not
        be reached by the proxy.
    </p>

    <p>
        <code>${escapeHtml(error.message || "Unknown error")}</code>
    </p>
</body>
</html>
        `);
    }
});


// ========================================
// URL rewriting
// ========================================

function rewriteAttribute($, element, attribute, baseURL) {
    const value = $(element).attr(attribute);

    if (!value) {
        return;
    }

    const trimmed = value.trim();

    if (
        trimmed.startsWith("#") ||
        trimmed.startsWith("javascript:") ||
        trimmed.startsWith("mailto:") ||
        trimmed.startsWith("tel:") ||
        trimmed.startsWith("data:") ||
        trimmed.startsWith("blob:")
    ) {
        return;
    }

    try {
        const absolute = new URL(
            trimmed,
            baseURL.href
        );

        if (
            absolute.protocol !== "http:" &&
            absolute.protocol !== "https:"
        ) {
            return;
        }

        $(element).attr(
            attribute,
            "/proxy?url=" +
            encodeURIComponent(absolute.href)
        );
    } catch {
        // Ignore malformed URLs.
    }
}


function rewriteCSSUrls(css, baseURL) {
    return css.replace(
        /url\(\s*(['"]?)(.*?)\1\s*\)/gi,
        (match, quote, value) => {
            const trimmed = value.trim();

            if (
                !trimmed ||
                trimmed.startsWith("data:") ||
                trimmed.startsWith("blob:") ||
                trimmed.startsWith("#")
            ) {
                return match;
            }

            try {
                const absolute = new URL(
                    trimmed,
                    baseURL.href
                );

                if (
                    absolute.protocol !== "http:" &&
                    absolute.protocol !== "https:"
                ) {
                    return match;
                }

                return `url("${proxyURL(absolute.href)}")`;
            } catch {
                return match;
            }
        }
    );
}


function proxyURL(url) {
    return "/proxy?url=" +
        encodeURIComponent(url);
}


// ========================================
// Basic private-address protection
// ========================================

function isPrivateAddress(address) {
    if (net.isIPv4(address)) {
        const parts = address
            .split(".")
            .map(Number);

        const a = parts[0];
        const b = parts[1];

        // 10.0.0.0/8
        if (a === 10) return true;

        // 172.16.0.0/12
        if (a === 172 && b >= 16 && b <= 31) {
            return true;
        }

        // 192.168.0.0/16
        if (a === 192 && b === 168) {
            return true;
        }

        // 127.0.0.0/8
        if (a === 127) return true;

        // 169.254.0.0/16
        if (a === 169 && b === 254) {
            return true;
        }

        return false;
    }

    if (net.isIPv6(address)) {
        const normalized = address.toLowerCase();

        if (normalized === "::1") return true;

        // IPv6 private/local ranges
        if (
            normalized.startsWith("fc") ||
            normalized.startsWith("fd") ||
            normalized.startsWith("fe80:")
        ) {
            return true;
        }

        return false;
    }

    return true;
}


// ========================================
// HTML escaping
// ========================================

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}


// ========================================
// Start server
// ========================================

app.listen(PORT, "0.0.0.0", () => {
    console.log(
        `Hollowsoft running on port ${PORT}`
    );
});
