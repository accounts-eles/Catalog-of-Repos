const puppeteer = require('puppeteer');
const { promises: fs } = require('fs');
const path = require('path');

// --- Configuration ---
const TARGET_ORG = 'accounts-eles';
const GITHUB_PAGES_BASE_URL = `https://${TARGET_ORG.toLowerCase()}.github.io/`;
const THUMBNAIL_WIDTH = 1200;
const THUMBNAIL_HEIGHT = 800;
const SCREENSHOT_DELAY_MS = 3000;

/**
 * Fetches all public repository names for the target org.
 */
async function fetchRepositoryNames() {
    console.log(`Fetching repositories for ${TARGET_ORG}...`);

    const token = process.env.ORG_PAT_TOKEN;
    if (!token) {
        console.error("FATAL: ORG_PAT_TOKEN environment variable not set.");
        return [];
    }

    const allRepoNames = [];
    let page = 1;
    let hasNextPage = true;

    while (hasNextPage) {
        const url = `https://api.github.com/user/repos?per_page=100&page=${page}`;
        const headers = {
            'User-Agent': 'GitHub-Actions-Repo-Preview-Generator',
            'Authorization': `token ${token}`,
            'Accept': 'application/vnd.github.mercy-preview+json',
        };

        try {
            const response = await fetch(url, { headers });
            if (!response.ok) {
                throw new Error(`GitHub API error: ${response.status} - ${response.statusText}`);
            }

            const data = await response.json();
            const linkHeader = response.headers.get('link');
            hasNextPage = linkHeader && linkHeader.includes('rel="next"');

            const names = data
                .filter(repo => repo.owner.login === TARGET_ORG)
                .filter(repo => repo.name !== 'Catalog_of_Repos')
                .map(repo => repo.name);

            allRepoNames.push(...names);
            page++;

        } catch (error) {
            console.error(`ERROR fetching repository list: ${error.message}`);
            hasNextPage = false;
        }
    }

    console.log(`Found ${allRepoNames.length} repositories in ${TARGET_ORG}.`);
    return allRepoNames;
}

/**
 * Pushes preview.png into the root of the target repo via the GitHub Contents API.
 * If the file already exists, it updates it (requires the existing file's SHA).
 */
async function pushPreviewToRepo(repoName, imageBuffer) {
    const token = process.env.ORG_PAT_TOKEN;
    const apiUrl = `https://api.github.com/repos/${TARGET_ORG}/${repoName}/contents/preview.png`;
    const headers = {
        'User-Agent': 'GitHub-Actions-Repo-Preview-Generator',
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
    };

    // Check if preview.png already exists (we need its SHA to update it)
    let existingSha = null;
    try {
        const checkResp = await fetch(apiUrl, { headers });
        if (checkResp.ok) {
            const existing = await checkResp.json();
            existingSha = existing.sha;
            console.log(`  Found existing preview.png (SHA: ${existingSha.slice(0, 7)}), will update.`);
        }
    } catch (e) {
        // File doesn't exist yet — that's fine, we'll create it
    }

    const base64Image = imageBuffer.toString('base64');

    const body = {
        message: `chore: update preview thumbnail [skip ci]`,
        content: base64Image,
        ...(existingSha && { sha: existingSha }),
    };

    const putResp = await fetch(apiUrl, {
        method: 'PUT',
        headers,
        body: JSON.stringify(body),
    });

    if (!putResp.ok) {
        const err = await putResp.json();
        throw new Error(`Failed to push preview.png to ${repoName}: ${JSON.stringify(err)}`);
    }

    console.log(`  Successfully pushed preview.png to ${repoName}.`);
}

/**
 * Screenshots the live GitHub Pages URL and pushes the image to the repo.
 */
async function processRepository(repoName, browser) {
    console.log(`\n--- Processing ${repoName} ---`);

    const tmpPath = path.join('/tmp', `${repoName}.png`);

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT });

        const liveUrl = `${GITHUB_PAGES_BASE_URL}${repoName}/`;
        console.log(`  Navigating to ${liveUrl}`);

        const response = await page.goto(liveUrl, {
            waitUntil: 'networkidle2',
            timeout: 60000,
        });

        if (!response || !response.ok()) {
            console.warn(`  WARNING: ${liveUrl} returned ${response ? response.status() : 'no response'}. Skipping.`);
            await page.close();
            return;
        }

        console.log(`  Waiting ${SCREENSHOT_DELAY_MS}ms for rendering...`);
        await new Promise(resolve => setTimeout(resolve, SCREENSHOT_DELAY_MS));

        await page.screenshot({
            path: tmpPath,
            fullPage: false,
            clip: { x: 0, y: 0, width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT },
        });

        await page.close();

        // Read the screenshot into a buffer and push to the repo
        const imageBuffer = await fs.readFile(tmpPath);
        await pushPreviewToRepo(repoName, imageBuffer);

        // Clean up temp file
        await fs.unlink(tmpPath).catch(() => {});

    } catch (error) {
        console.error(`  FATAL ERROR processing ${repoName}: ${error.message}`);
    }
}

/**
 * Main execution function.
 */
async function main() {
    const REPO_NAMES = await fetchRepositoryNames();

    if (REPO_NAMES.length === 0) {
        console.log('No repositories found. Exiting.');
        return;
    }

    let browser;
    try {
        console.log('Launching headless browser...');
        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
            ],
        });

        for (const repoName of REPO_NAMES) {
            await processRepository(repoName, browser);
        }

    } catch (error) {
        console.error('Critical error during main execution:', error.message);
        process.exit(1);
    } finally {
        if (browser) {
            await browser.close();
            console.log('Browser closed.');
        }
        console.log('\n--- Script finished ---');
    }
}

main();
