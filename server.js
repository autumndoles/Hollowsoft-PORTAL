const express = require("express");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;

// Serve the portal itself
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

    // URL
    if (
        /^https?:\/\//i.test(input) ||
        /^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(input)
    ) {
        destination = /^https?:\/\//i.test(input)
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

    // Only HTTP/HTTPS
    if (
        targetURL.protocol !== "http:" &&
        targetURL.protocol !== "https:"
    ) {
        return res.status(400).send("Unsupported protocol.");
    }

    try {
        const response = await fetch(targetURL, {
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (compatible; Hollowsoft/1.0)"
            },
            redirect: "follow"
        });

        const contentType =
            response.headers.get("content-type") || "";

        // --------------------------------
        // Non-HTML resources
        // --------------------------------

        if (!contentType.includes("text/html")) {
            const buffer = Buffer.from(
                await response.arrayBuffer()
            );

            res.status(response.status);
            res.set("Content-Type", contentType);

            return res.send(buffer);
        }


        // --------------------------------
        // HTML
        // --------------------------------

        const html = await response.text();

        const $ = cheerio.load(html);


        // --------------------------------
        // Rewrite links
        // --------------------------------

        $("a[href]").each((_, element) => {
            const value = $(element).attr("href");

            if (!value) return;

            if (
                value.startsWith("#") ||
                value.startsWith("javascript:") ||
                value.startsWith("mailto:")
            ) {
                return;
            }

            try {
                const absolute = new URL(value, targetURL.href);

                if (
                    absolute.protocol === "http:" ||
                    absolute.protocol === "https:"
                ) {
                    $(element).attr(
                        "href",
                        "/proxy?url=" +
                        encodeURIComponent(absolute.href)
                    );
                }
            } catch {
                // Ignore invalid URLs
            }
        });


        // --------------------------------
        // Rewrite images
        // --------------------------------

        $("img[src]").each((_, element) => {
            rewriteAttribute(
                $,
                element,
                "src",
                targetURL
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
                targetURL
            );
        });


        // --------------------------------
        // Rewrite stylesheets
        // --------------------------------

        $('link[href]').each((_, element) => {
            rewriteAttribute(
                $,
                element,
                "href",
                targetURL
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
                    targetURL
                );
            }
        );


        // --------------------------------
        // Rewrite forms
        // --------------------------------

        $("form[action]").each((_, element) => {
            const value = $(element).attr("action");

            if (!value) return;

            try {
                const absolute = new URL(
                    value,
                    targetURL.href
                );

                if (
                    absolute.protocol === "http:" ||
                    absolute.protocol === "https:"
                ) {
                    $(element).attr(
                        "action",
                        "/proxy?url=" +
                        encodeURIComponent(absolute.href)
                    );
                }
            } catch {
                // Ignore invalid URLs
            }
        });


        // --------------------------------
        // Tell the browser where relative
        // URLs originally came from.
        // --------------------------------

        $("head").prepend(
            `<base href="${escapeHtml(targetURL.href)}">`
        );


        // --------------------------------
        // Send modified page
        // --------------------------------

        res.status(response.status);

        res.set(
            "Content-Type",
            "text/html; charset=utf-8"
        );

        res.send($.html());

    } catch (error) {
        console.error("Proxy error:", error);

        res.status(502).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Hollowsoft Proxy Error</title>
                <style>
                    body {
                        background: #111;
                        color: white;
                        font-family: Arial, sans-serif;
                        text-align: center;
                        padding: 50px;
                    }

                    h1 {
                        font-size: 32px;
                    }

                    p {
                        color: #aaa;
                    }
                </style>
            </head>

            <body>
                <h1>Hollowsoft couldn't load that page.</h1>
                <p>
                    The target website may have blocked the request,
                    require JavaScript, or otherwise be incompatible
                    with the current proxy.
                </p>
            </body>
            </html>
        `);
    }
});


// ========================================
// Helpers
// ========================================

function rewriteAttribute($, element, attribute, baseURL) {
    const value = $(element).attr(attribute);

    if (!value) return;

    if (
        value.startsWith("data:") ||
        value.startsWith("blob:") ||
        value.startsWith("#")
    ) {
        return;
    }

    try {
        const absolute = new URL(
            value,
            baseURL.href
        );

        if (
            absolute.protocol === "http:" ||
            absolute.protocol === "https:"
        ) {
            $(element).attr(
                attribute,
                "/proxy?url=" +
                encodeURIComponent(absolute.href)
            );
        }
    } catch {
        // Ignore invalid URLs
    }
}


function escapeHtml(value) {
    return value
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
