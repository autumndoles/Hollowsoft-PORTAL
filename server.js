const express = require("express");
const cheerio = require("cheerio");
const dns = require("dns").promises;
const net = require("net");

const app = express();
const PORT = process.env.PORT || 3000;

// ==================================================
// STATIC PORTAL
// ==================================================

app.use(express.static("."));

// ==================================================
// SCRATCH DIRECT ROUTES
// ==================================================

// If Scratch's client-side router changes the browser
// to /projects/123/, catch it here.
app.use((req, res, next) => {
    if (
        req.path.startsWith("/projects/") ||
        req.path.startsWith("/studios/") ||
        req.path.startsWith("/users/")
    ) {
        const target =
            "https://scratch.mit.edu" +
            req.originalUrl;

        console.log("Scratch navigation:", target);

        return proxyRequest(target, req, res);
    }

    next();
});

// ==================================================
// UNIFIED SEARCH
// ==================================================

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
        destination =
            /^https?:\/\//i.test(input)
                ? input
                : "https://" + input;
    } else {
        destination =
            "https://www.google.com/search?q=" +
            encodeURIComponent(input);
    }

    res.redirect(
        "/proxy?url=" +
        encodeURIComponent(destination)
    );
});

// ==================================================
// MAIN PROXY
// ==================================================

app.get("/proxy", async (req, res) => {
    const target = req.query.url;

    if (!target) {
        return res.status(400).send("Missing URL.");
    }

    return proxyRequest(target, req, res);
});

// ==================================================
// PROXY ENGINE
// ==================================================

async function proxyRequest(target, req, res) {
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
        return res.status(400).send(
            "Only HTTP and HTTPS are supported."
        );
    }

    // ==================================================
    // PRIVATE NETWORK PROTECTION
    // ==================================================

    try {
        const addresses = await dns.lookup(
            targetURL.hostname,
            {
                all: true
            }
        );

        for (const address of addresses) {
            if (isPrivateAddress(address.address)) {
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

    // ==================================================
    // HOST DETECTION
    // ==================================================

    const hostname =
        targetURL.hostname.toLowerCase();

    const isScratch =
        hostname === "scratch.mit.edu" ||
        hostname.endsWith(".scratch.mit.edu");

    // ==================================================
    // REQUEST
    // ==================================================

    try {
        const headers = {
            "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
                "AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/140.0.0.0 Safari/537.36",

            "Accept":
                "text/html,application/xhtml+xml," +
                "application/xml;q=0.9," +
                "image/avif,image/webp," +
                "image/apng,*/*;q=0.8",

            "Accept-Language":
                "en-US,en;q=0.9"
        };

        if (isScratch) {
            headers["Referer"] =
                "https://scratch.mit.edu/";

            headers["Origin"] =
                "https://scratch.mit.edu";
        }

        const response = await fetch(
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
            `[${response.status}] ${finalURL.href}`
        );

        // ==================================================
        // NON-HTML FILES
        // ==================================================

        if (
            !contentType
                .toLowerCase()
                .includes("text/html")
        ) {
            const data = Buffer.from(
                await response.arrayBuffer()
            );

            res.status(response.status);

            if (contentType) {
                res.set(
                    "Content-Type",
                    contentType
                );
            }

            // Preserve useful headers
            const cacheControl =
                response.headers.get(
                    "cache-control"
                );

            if (cacheControl) {
                res.set(
                    "Cache-Control",
                    cacheControl
                );
            }

            return res.send(data);
        }

        // ==================================================
        // HTML
        // ==================================================

        const html =
            await response.text();

        const $ =
            cheerio.load(html);

        // ==================================================
        // REWRITE HTML LINKS
        // ==================================================

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

        // ==================================================
        // IMAGES
        // ==================================================

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

        // ==================================================
        // SCRIPTS
        // ==================================================

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

        // ==================================================
        // CSS
        // ==================================================

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

        $("style").each(
            (_, element) => {
                let css =
                    $(element).html();

                if (!css) return;

                css =
                    rewriteCSSUrls(
                        css,
                        finalURL
                    );

                $(element).html(css);
            }
        );

        // ==================================================
        // IFRAME
        // ==================================================

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

        // ==================================================
        // MEDIA
        // ==================================================

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

        // ==================================================
        // FORMS
        // ==================================================

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

        // ==================================================
        // INJECT JAVASCRIPT PROXY LAYER
        // ==================================================

        const proxyScript = `
<script>
(function() {

    const HOLLOW_PROXY = "/proxy?url=";

    const ORIGINAL_HOST =
        ${JSON.stringify(finalURL.origin)};

    function makeProxyURL(url) {

        try {

            const absolute =
                new URL(
                    url,
                    ${JSON.stringify(finalURL.href)}
                );

            if (
                absolute.protocol !== "http:" &&
                absolute.protocol !== "https:"
            ) {
                return url;
            }

            // Don't proxy our own Hollowsoft URLs.
            if (
                absolute.origin ===
                    window.location.origin
            ) {
                return absolute.href;
            }

            return (
                HOLLOW_PROXY +
                encodeURIComponent(
                    absolute.href
                )
            );

        } catch {
            return url;
        }
    }

    // ==================================================
    // FETCH
    // ==================================================

    const originalFetch =
        window.fetch;

    window.fetch =
        function(input, init) {

            try {

                if (
                    typeof input ===
                    "string"
                ) {

                    input =
                        makeProxyURL(
                            input
                        );

                } else if (
                    input instanceof Request
                ) {

                    const proxied =
                        makeProxyURL(
                            input.url
                        );

                    input =
                        new Request(
                            proxied,
                            input
                        );
                }

            } catch (error) {

                console.warn(
                    "Hollowsoft fetch rewrite failed:",
                    error
                );

            }

            return originalFetch.call(
                this,
                input,
                init
            );
        };

    // ==================================================
    // XHR
    // ==================================================

    const originalOpen =
        XMLHttpRequest.prototype.open;

    XMLHttpRequest.prototype.open =
        function(
            method,
            url,
            async,
            user,
            password
        ) {

            try {

                url =
                    makeProxyURL(
                        url
                    );

            } catch {}

            return originalOpen.call(
                this,
                method,
                url,
                async,
                user,
                password
            );
        };

    // ==================================================
    // WEBSOCKET
    // ==================================================

    const OriginalWebSocket =
        window.WebSocket;

    window.WebSocket =
        function(url, protocols) {

            console.warn(
                "Hollowsoft: WebSocket requested:",
                url
            );

            return new OriginalWebSocket(
                url,
                protocols
            );
        };

    window.WebSocket.prototype =
        OriginalWebSocket.prototype;

    // ==================================================
    // HISTORY NAVIGATION
    // ==================================================

    function navigate(url) {

        try {

            const absolute =
                new URL(
                    url,
                    ${JSON.stringify(finalURL.href)}
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

            if (
                current.pathname ===
                    "/proxy" &&
                currentTarget ===
                    absolute.href
            ) {
                return;
            }

            window.location.href =
                makeProxyURL(
                    absolute.href
                );

        } catch (error) {

            console.error(
                "Hollowsoft navigation error:",
                error
            );

        }
    }

    const originalPushState =
        history.pushState;

    history.pushState =
        function(
            state,
            title,
            url
        ) {

            if (url) {
                navigate(url);
                return;
            }

            return originalPushState.apply(
                history,
                arguments
            );
        };

    const originalReplaceState =
        history.replaceState;

    history.replaceState =
        function(
            state,
            title,
            url
        ) {

            if (url) {
                navigate(url);
                return;
            }

            return originalReplaceState.apply(
                history,
                arguments
            );
        };

    // ==================================================
    // SCRATCH PROJECT LINKS
    // ==================================================

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
                        ${JSON.stringify(finalURL.href)}
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

                    navigate(
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

        // Put our interception code as early as
        // possible in the document.
        if ($("head").length) {
            $("head").prepend(
                proxyScript
            );
        } else {
            $.root().prepend(
                proxyScript
            );
        }

        // ==================================================
        // SEND PAGE
        // ==================================================

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

// ==================================================
// HTML ATTRIBUTE REWRITER
// ==================================================

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

// ==================================================
// CSS URL REWRITER
// ==================================================

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
                    'url("/proxy?url=' +
                    encodeURIComponent(
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

// ==================================================
// PRIVATE ADDRESS CHECK
// ==================================================

function isPrivateAddress(
    address
) {

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

        if (a === 10) {
            return true;
        }

        if (
            a === 172 &&
            b >= 16 &&
            b <= 31
        ) {
            return true;
        }

        if (
            a === 192 &&
            b === 168
        ) {
            return true;
        }

        if (a === 127) {
            return true;
        }

        if (
            a === 169 &&
            b === 254
        ) {
            return true;
        }

        return false;
    }

    if (
        net.isIPv6(address)
    ) {

        const normalized =
            address.toLowerCase();

        if (
            normalized === "::1"
        ) {
            return true;
        }

        if (
            normalized.startsWith("fc") ||
            normalized.startsWith("fd")
        ) {
            return true;
        }

        if (
            normalized.startsWith("fe80:")
        ) {
            return true;
        }

        return false;
    }

    return true;
}

// ==================================================
// HTML ESCAPING
// ==================================================

function escapeHtml(value) {

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

// ==================================================
// START SERVER
// ==================================================

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `Hollowsoft running on port ${PORT}`
        );

    }
);
