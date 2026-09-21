app.get("/go", (req, res) => {
    const input = (req.query.q || "").trim();

    if (!input) {
        return res.redirect("/");
    }

    let destination;

    // Looks like a URL
    if (
        /^https?:\/\//i.test(input) ||
        /^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(input)
    ) {
        destination = /^https?:\/\//i.test(input)
            ? input
            : "https://" + input;
    } else {
        // Treat it as a search
        destination =
            "https://www.google.com/search?q=" +
            encodeURIComponent(input);
    }

    res.redirect("/proxy?url=" + encodeURIComponent(destination));
});
