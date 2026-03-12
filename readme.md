🖼️ Repository Catalog

This repository serves as the central catalog for all deployed web applications within the accounts-eles organization. Its primary function is to automatically generate and store high-quality, up-to-date visual previews (thumbnails) for every single application hosted via GitHub Pages.

This ensures a dynamic and visual showcase of all active projects, making it easier to see what each repository contains without having to visit the live site.

✨ Features

The preview generation is managed entirely by a GitHub Actions workflow that runs automatically on every push to the main branch.

Dynamic Discovery: Uses the GitHub API to dynamically fetch the names of all public repositories within the DapaLMS1 organization (excluding this catalog itself).

Live Application Screenshotting: The Node.js script uses Puppeteer to launch a headless browser. It navigates to the live deployed GitHub Pages URL for each repository (e.g., https://tbd.github.io/RepoName/).

High-Fidelity Thumbnails: Captures a high-resolution screenshot (1200x800px) of the live application after allowing a 3-second delay for all client-side JavaScript (React, Angular, etc.) to fully render.

Automatic Commit: The generated thumbnails are automatically committed back to this repository, ensuring the previews/ directory is always current.

📂 Generated Preview Files

All generated thumbnail images are stored in the previews/ directory using the naming convention [RepoName].png.

These images can be easily referenced in other documents, such as a main organizational landing page or another repository's README, to provide a visual link.

Example Usage (Embedding Previews)

You can embed the live previews directly into Markdown using the following structure:

Repository Name

Live Preview

Acts-and-Regulators



User-Management-App



Financial-Tracker



(Note: Replace the example repository names with the actual names of your projects.)

🛠️ Workflow Details

The automation is handled by the Generate Repository Social Preview Card workflow defined in .github/workflows/generate_social_card.yml.

Trigger: Runs on every push to main and on manual workflow_dispatch.

Script: generate_preview_script.js

Output Directory: previews/
