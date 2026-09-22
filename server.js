const express = require("express");
const cheerio = require("cheerio");
const dns = require("dns").promises;
const net = require("net");

const app = express();
const PORT = process.env.PORT || 3000;

// --------------------------------------------------
// Hollowsoft Portal
// --------------------------------------------------

app.use(express.static("."));

// --------------------------------------------------
// Scratch route handling
// --------------------------------------------------

// Scratch project pages sometimes navigate to:
//
// /projects/123456789/
//
// Catch those and proxy them to Scratch.
app.use(async (req, res, next) => {
    if (
        req.path.startsWith("/projects/") ||
        req.path.startsWith("/project/") ||
        req.path.startsWith("/api/")
    ) {
        const scratchURL =
            "https://scratch.mit.edu" +
            req.originalUrl;

        console.log(
            "Scratch route:",
            scratchURL
        );

        return proxyRequest(
            scratchURL,
            req,
            res
        );
    }

    next();
});

// --------------------------------------------------
// Unified search box
// --------------------------------------------------

app.get("/go", (req, res) => {
    const input =
        (req.query.q || "").trim();

    if (!input) {
        return res.redirect("/");
    }

    let destination;

    // URL
    if (
        /^https?:\/\//i.test(input) ||
        /^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(input)
    ) {
        destination =
            /^https?:\/\//i.test(input)
                ? input
                : "https://" + input;
    }

    // Search
    else {
        destination =
            "https://www.google.com/search?q=" +
            encodeURIComponent(input);
    }

    res.redirect(
        "/proxy?url=" +
        encodeURIComponent(destination)
    );
});

// --------------------------------------------------
// Main proxy
// --------------------------------------------------

app.get("/proxy", async (req, res) => {
    const target = req.query.url;

    if (!target) {
        return res.status(400).send(
            "Missing URL."
        );
    }

    return proxyRequest(
        target,
        req,
        res
    );
});

// --------------------------------------------------
// Proxy engine
// --------------------------------------------------

async function proxyRequest(
    target,
    req,
    res
) {
    let targetURL;

    try {
        targetURL =
            new URL(target);
    } catch {
        return res.status(400).send(
            "Invalid URL."
        );
    }

    if (
        targetURL.protocol !== "http:" &&
        targetURL.protocol !== "https:"
    ) {
        return res.status(400).send(
            "Only HTTP and HTTPS are supported."
        );
    }

    // --------------------------------------------------
    // Prevent private network access
    // --------------------------------------------------

    try {
        const addresses =
            await dns.lookup(
                targetURL.hostname,
                {
                    all: true
                }
            );

        for (
            const address of addresses
        ) {
            if (
                isPrivateAddress(
                    address.address
                )
            ) {
                return res.status(403).send(
                    "Access to private network addresses is not allowed."
                );
            }
        }
    } catch {
        return res.status(502).send(
            "Could not resolve the target host."
        );
    }

    // --------------------------------------------------
    // Detect Scratch
    // --------------------------------------------------

    const isScratch =
        targetURL.hostname ===
            "scratch.mit.edu" ||
        targetURL.hostname.endsWith(
            ".scratch.mit.edu"
        );

    try {
        // --------------------------------------------------
        // Request headers
        // --------------------------------------------------

        const headers = {
            "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
                "AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/140.0.0.0 Safari/537.36",

            "Accept":
                "text/html,application/xhtml+xml," +
                "application/xml;q=0.9," +
                "image/avif,image/webp," +
                "image/apng,*/*;q=0.8"
        };

        // Scratch expects normal browser-ish headers
        if (isScratch) {
            headers["Referer"] =
                "https://scratch.mit.edu/";

            headers["Accept-Language"] =
                "en-US,en;q=0.9";
        }

        const response =
            await fetch(
                targetURL,
                {
                    redirect: "follow",
                    headers
                }
            );

        const finalURL =
            new URL(response.url);

        const contentType =
            response.headers.get(
                "content-type"
            ) || "";

        console.log(
            `${response.status} ${finalURL.href}`
        );

        // --------------------------------------------------
        // Non-HTML content
        // --------------------------------------------------

        if (
            !contentType
                .toLowerCase()
                .includes("text/html")
        ) {
            const data =
                Buffer.from(
                    await response.arrayBuffer()
                );

            res.status(
                response.status
            );

            if (contentType) {
                res.set(
                    "Content-Type",
                    contentType
                );
            }

            return res.send(
                data
            );
        }

        // --------------------------------------------------
        // HTML
        // --------------------------------------------------

        const html =
            await response.text();

        const $ =
            cheerio.load(
                html
            );

        // --------------------------------------------------
        // Rewrite links
        // --------------------------------------------------

        $("a[href]").each(
            (_, element) => {
                rewriteAttribute(
                    $,
                    element,
                    "href",
                    finalURL
                );
            }
        );

        // --------------------------------------------------
        // Images
        // --------------------------------------------------

        $("img[src]").each(
            (_, element) => {
                rewriteAttribute(
                    $,
                    element,
                    "src",
                    finalURL
                );
            }
        );

        // --------------------------------------------------
        // Scripts
        // --------------------------------------------------

        $("script[src]").each(
            (_, element) => {
                rewriteAttribute(
                    $,
                    element,
                    "src",
                    finalURL
                );
            }
        );

        // --------------------------------------------------
        // Stylesheets
        // --------------------------------------------------

        $("link[href]").each(
            (_, element) => {
                rewriteAttribute(
                    $,
                    element,
                    "href",
                    finalURL
                );
            }
        );

        // --------------------------------------------------
        // Iframes
        // --------------------------------------------------

        $("iframe[src]").each(
            (_, element) => {
                rewriteAttribute(
                    $,
                    element,
                    "src",
                    finalURL
                );
            }
        );

        // --------------------------------------------------
        // Video/audio
        // --------------------------------------------------

        $(
            "video[src], audio[src], source[src]"
        ).each(
            (_, element) => {
                rewriteAttribute(
                    $,
                    element,
                    "src",
                    finalURL
                );
            }
        );

        // --------------------------------------------------
        // Forms
        // --------------------------------------------------

        $("form[action]").each(
            (_, element) => {
                rewriteAttribute(
                    $,
                    element,
                    "action",
                    finalURL
                );
            }
        );

        // --------------------------------------------------
        // Inline CSS
        // --------------------------------------------------

        $("style").each(
            (_, element) => {
                let css =
                    $(element).html();

                if (!css) {
                    return;
                }

                css =
                    rewriteCSSUrls(
                        css,
                        finalURL
                    );

                $(element).html(
                    css
                );
            }
        );

        // --------------------------------------------------
        // Scratch-specific navigation
        // --------------------------------------------------

        const navigationScript = `
<script>
(function() {

    const HOLLOWSOFT_PROXY =
        "/proxy?url=";

    function hollowsoftProxy(url) {

        try {

            const absolute =
                new URL(
                    url,
                    ${JSON.stringify(
                        finalURL.href
                    )}
                );

            if (
                absolute.protocol !== "http:" &&
                absolute.protocol !== "https:"
            ) {
                return;
            }

            const current =
                new URL(
                    window.location.href
                );

            const currentTarget =
                current.searchParams.get(
                    "url"
                );

            // Already proxied
            if (
                current.pathname ===
                    "/proxy" &&
                currentTarget ===
                    absolute.href
            ) {
                return;
            }

            window.location.href =
                HOLLOWSOFT_PROXY +
                encodeURIComponent(
                    absolute.href
                );

        } catch (error) {

            console.error(
                "Hollowsoft navigation error:",
                error
            );

        }
    }

    // ----------------------------------------------
    // pushState
    // ----------------------------------------------

    const originalPushState =
        history.pushState;

    history.pushState =
        function(
            state,
            title,
            url
        ) {

            if (url) {
                hollowsoftProxy(
                    url
                );
                return;
            }

            return originalPushState.apply(
                history,
                arguments
            );
        };

    // ----------------------------------------------
    // replaceState
    // ----------------------------------------------

    const originalReplaceState =
        history.replaceState;

    history.replaceState =
        function(
            state,
            title,
            url
        ) {

            if (url) {
                hollowsoftProxy(
                    url
                );
                return;
            }

            return originalReplaceState.apply(
                history,
                arguments
            );
        };

    // ----------------------------------------------
    // Scratch project links
    // ----------------------------------------------

    document.addEventListener(
        "click",
        function(event) {

            const link =
                event.target.closest(
                    "a"
                );

            if (!link) {
                return;
            }

            const href =
                link.getAttribute(
                    "href"
                );

            if (!href) {
                return;
            }

            try {

                const absolute =
                    new URL(
                        href,
                        ${JSON.stringify(
                            finalURL.href
                        )}
                    );

                if (
                    absolute.hostname ===
                        "scratch.mit.edu" &&
                    (
                        absolute.pathname.startsWith(
                            "/projects/"
                        ) ||
                        absolute.pathname.startsWith(
                            "/studios/"
                        ) ||
                        absolute.pathname.startsWith(
                            "/users/"
                        )
                    )
                ) {

                    event.preventDefault();
                    event.stopPropagation();

                    hollowsoftProxy(
                        absolute.href
                    );
                }

            } catch {}

        },
        true
    );

})();
</script>
`;

        if ($("body").length) {
            $("body").append(
                navigationScript
            );
        } else {
            $.root().append(
                navigationScript
            );
        }

        // --------------------------------------------------
        // Return modified page
        // --------------------------------------------------

        res.status(
            response.status
        );

        res.set(
            "Content-Type",
            "text/html; charset=utf-8"
        );

        return res.send(
            $.html()
        );

    } catch (error) {

        console.error(
            "Hollowsoft proxy error:",
            error
        );

        return res.status(
            502
        ).send(`
<!DOCTYPE html>

<html>

<head>

    <meta charset="UTF-8">

    <title>
        Hollowsoft Proxy Error
    </title>

    <style>

        body {
            margin: 0;
            padding: 50px;

            background: #111;
            color: white;

            font-family:
                Arial,
                sans-serif;

            text-align: center;
        }

        h1 {
            font-size: 32px;
        }

        p {
            color: #aaa;
        }

        code {
            color: white;
        }

    </style>

</head>

<body>

    <h1>
        Hollowsoft couldn't load that page.
    </h1>

    <p>
        The target website rejected the request
        or could not be reached by the proxy.
    </p>

    <p>
        <code>
            ${escapeHtml(
                error.message ||
                "Unknown error"
            )}
        </code>
    </p>

</body>

</html>
        `);
    }
}

// --------------------------------------------------
// Rewrite HTML attributes
// --------------------------------------------------

function rewriteAttribute(
    $,
    element,
    attribute,
    baseURL
) {

    const value =
        $(element).attr(
            attribute
        );

    if (!value) {
        return;
    }

    const trimmed =
        value.trim();

    // Special URLs
    if (
        trimmed.startsWith("#") ||
        trimmed.startsWith(
            "javascript:"
        ) ||
        trimmed.startsWith(
            "mailto:"
        ) ||
        trimmed.startsWith(
            "tel:"
        ) ||
        trimmed.startsWith(
            "data:"
        ) ||
        trimmed.startsWith(
            "blob:"
        )
    ) {
        return;
    }

    try {

        const absolute =
            new URL(
                trimmed,
                baseURL.href
            );

        if (
            absolute.protocol !==
                "http:" &&
            absolute.protocol !==
                "https:"
        ) {
            return;
        }

        $(element).attr(
            attribute,
            "/proxy?url=" +
                encodeURIComponent(
                    absolute.href
                )
        );

    } catch {}

}

// --------------------------------------------------
// Rewrite CSS URLs
// --------------------------------------------------

function rewriteCSSUrls(
    css,
    baseURL
) {

    return css.replace(
        /url\(\s*(['"]?)(.*?)\1\s*\)/gi,

        (
            match,
            quote,
            value
        ) => {

            const trimmed =
                value.trim();

            if (
                !trimmed ||
                trimmed.startsWith(
                    "data:"
                ) ||
                trimmed.startsWith(
                    "blob:"
                ) ||
                trimmed.startsWith(
                    "#"
                )
            ) {
                return match;
            }

            try {

                const absolute =
                    new URL(
                        trimmed,
                        baseURL.href
                    );

                if (
                    absolute.protocol !==
                        "http:" &&
                    absolute.protocol !==
                        "https:"
                ) {
                    return match;
                }

                return (
                    'url("' +
                    proxyURL(
                        absolute.href
                    ) +
                    '")'
                );

            } catch {

                return match;

            }

        }
    );

}

// --------------------------------------------------
// Create proxy URL
// --------------------------------------------------

function proxyURL(url) {

    return (
        "/proxy?url=" +
        encodeURIComponent(
            url
        )
    );

}

// --------------------------------------------------
// Private IP protection
// --------------------------------------------------

function isPrivateAddress(
    address
) {

    // IPv4
    if (
        net.isIPv4(address)
    ) {

        const parts =
            address
                .split(".")
                .map(Number);

        const a =
            parts[0];

        const b =
            parts[1];

        // 10.0.0.0/8
        if (
            a === 10
        ) {
            return true;
        }

        // 172.16.0.0/12
        if (
            a === 172 &&
            b >= 16 &&
            b <= 31
        ) {
            return true;
        }

        // 192.168.0.0/16
        if (
            a === 192 &&
            b === 168
        ) {
            return true;
        }

        // 127.0.0.0/8
        if (
            a === 127
        ) {
            return true;
        }

        // 169.254.0.0/16
        if (
            a === 169 &&
            b === 254
        ) {
            return true;
        }

        return false;
    }

    // IPv6
    if (
        net.isIPv6(address)
    ) {

        const normalized =
            address.toLowerCase();

        // Loopback
        if (
            normalized === "::1"
        ) {
            return true;
        }

        // Unique local
        if (
            normalized.startsWith(
                "fc"
            ) ||
            normalized.startsWith(
                "fd"
            )
        ) {
            return true;
        }

        // Link-local
        if (
            normalized.startsWith(
                "fe80:"
            )
        ) {
            return true;
        }

        return false;
    }

    return true;
}

// --------------------------------------------------
// HTML escaping
// --------------------------------------------------

function escapeHtml(
    value
) {

    return String(value)
        .replace(
            /&/g,
            "&amp;"
        )
        .replace(
            /"/g,
            "&quot;"
        )
        .replace(
            /</g,
            "&lt;"
        )
        .replace(
            />/g,
            "&gt;"
        );

}

// --------------------------------------------------
// Start Hollowsoft
// --------------------------------------------------

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `Hollowsoft running on port ${PORT}`
        );

    }
);
