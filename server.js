const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// Serve the Hollowsoft frontend
app.use(express.static("public"));


// ========================================
// Unified search / URL handler
// ========================================

app.get("/go", (req, res) => {
    const input = (req.query.q || "").trim();

    if (!input) {
        return res.redirect("/");
    }

    let destination;

    // If it looks like a URL, open that URL.
    if (
        /^https?:\/\//i.test(input) ||
        /^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(input)
    ) {
        destination = /^https?:\/\//i.test(input)
            ? input
            : "https://" + input;
    } else {
        // Otherwise, treat it as a Google search.
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

    // Only allow HTTP and HTTPS.
    if (
        targetURL.protocol !== "http:" &&
        targetURL.protocol !== "https:"
    ) {
        return res.status(400).send("Unsupported protocol.");
    }

    try {
        const response = await fetch(targetURL, {
            headers: {
                "User-Agent": "Hollowsoft/1.0"
            },
            redirect: "follow"
        });

        const contentType =
            response.headers.get("content-type") ||
            "text/plain";

        const body = await response.text();

        res.status(response.status);
        res.set("Content-Type", contentType);
        res.send(body);

    } catch (error) {
        console.error("Proxy error:", error);

        res.status(502).send(
            "Hollowsoft could not reach that website."
        );
    }
});


// ========================================
// Start server
// ========================================

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Hollowsoft running on port ${PORT}`);
});
