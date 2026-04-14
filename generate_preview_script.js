const puppeteer = require('puppeteer');
const { promises: fs } = require('fs');
const path = require('path');
const http = require('http');

// --- Configuration ---
const TARGET_ORG = 'accounts-eles';
const GITHUB_PAGES_BASE_URL = `https://${TARGET_ORG.toLowerCase()}.github.io/`;
const DRIVE_REPO_NAME = 'Google-Drive';
const THUMBNAIL_WIDTH = 1200;
const THUMBNAIL_HEIGHT = 800;
const SCREENSHOT_DELAY_MS = 3000;
const LOCAL_SERVER_PORT = 8080;

// --- Mode ---
const RUN_MODE = process.env.RUN_MODE || 'pages'; // 'pages' or 'local'

// ─────────────────────────────────────────────
// SHARED UTILITIES
// ─────────────────────────────────────────────

/**
 * Pushes preview.png into a specific path in a repo via the GitHub Contents API.
 */
async function pushPreviewToRepo(repoName, filePath, imageBuffer) {
    const token = process.env.ORG_PAT_TOKEN;
    const apiUrl = `https://api.github.com/repos/${TARGET_ORG}/${repoName}/contents/${filePath}`;
    const headers = {
        'User-Agent': 'GitHub-Actions-Repo-Preview-Generator',
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
    };

    // Check if file already exists (need SHA to update)
    let existingSha = null;
    try {
        const checkResp = await fetch(apiUrl, { headers });
        if (checkResp.ok) {
            const existing = await checkResp.json();
            existingSha = existing.sha;
            console.log(`  Found existing ${filePath} (SHA: ${existingSha.slice(0, 7)}), will update.`);
        }
    } catch (e) {
        // File doesn't exist yet, will create
    }

    const body = {
        message: `chore: update preview thumbnail [skip ci]`,
        content: imageBuffer.toString('base64'),
        ...(existingSha && { sha: existingSha }),
    };

    const putResp = await fetch(apiUrl, {
        method: 'PUT',
        headers,
        body: JSON.stringify(body),
    });

    if (!putResp.ok) {
        const err = await putResp.json();
        throw new Error(`Failed to push ${filePath}: ${JSON.stringify(err)}`);
    }

    console.log(`  Successfully pushed ${filePath} to ${repoName}.`);
}

/**
 * Takes a screenshot of a given URL and returns the image as a Buffer.
 */
async function screenshotUrl(url, browser) {
    const page = await browser.newPage();
    await page.setViewport({ width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT });

    console.log(`  Navigating to ${url}`);
    const response = await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: 60000,
    });

    if (!response || !response.ok()) {
        console.warn(`  WARNING: ${url} returned ${response ? response.status() : 'no response'}. Skipping.`);
        await page.close();
        return null;
    }

    console.log(`  Waiting ${SCREENSHOT_DELAY_MS}ms for rendering...`);
    await new Promise(resolve => setTimeout(resolve, SCREENSHOT_DELAY_MS));

    const tmpPath = path.join('/tmp', `preview_${Date.now()}.png`);
    await page.screenshot({
        path: tmpPath,
        fullPage: false,
        clip: { x: 0, y: 0, width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT },
    });

    await page.close();

    const buffer = await fs.readFile(tmpPath);
    await fs.unlink(tmpPath).catch(() => {});
    return buffer;
}

// ─────────────────────────────────────────────
// MODE A — GitHub Pages (existing behaviour)
// ─────────────────────────────────────────────

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
            if (!response.ok) throw new Error(`${response.status} - ${response.statusText}`);

            const data = await response.json();
            const linkHeader = response.headers.get('link');
            hasNextPage = linkHeader && linkHeader.includes('rel="next"');

            const names = data
                .filter(repo => repo.owner.login === TARGET_ORG)
                .filter(repo => repo.name !== 'Catalog_of_Repos')
                .filter(repo => repo.name !== DRIVE_REPO_NAME)
                .map(repo => repo.name);

            allRepoNames.push(...names);
            page++;

        } catch (error) {
            console.error(`ERROR fetching repository list: ${error.message}`);
            hasNextPage = false;
        }
    }

    console.log(`Found ${allRepoNames.length} repositories.`);
    return allRepoNames;
}

async function runModePages(browser) {
    const repoNames = await fetchRepositoryNames();
    if (repoNames.length === 0) {
        console.log('No repositories found.');
        return;
    }

    for (const repoName of repoNames) {
        console.log(`\n--- [Pages] Processing ${repoName} ---`);
        try {
            const liveUrl = `${GITHUB_PAGES_BASE_URL}${repoName}/`;
            const imageBuffer = await screenshotUrl(liveUrl, browser);
            if (imageBuffer) {
                await pushPreviewToRepo(repoName, 'preview.png', imageBuffer);
            }
        } catch (error) {
            console.error(`  ERROR: ${error.message}`);
        }
    }
}

// ─────────────────────────────────────────────
// MODE B — Local Google Drive folders
// ─────────────────────────────────────────────

/**
 * Starts a static HTTP server serving files from a given directory.
 * Returns a server instance that can be closed later.
 */
function startLocalServer(directory) {
    return new Promise((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            // Decode the URL and strip query strings
            const urlPath = decodeURIComponent(req.url.split('?')[0]);
            let filePath = path.join(directory, urlPath === '/' ? 'index.html' : urlPath);

            try {
                const data = await fs.readFile(filePath);
                const ext = path.extname(filePath).toLowerCase();
                const mimeTypes = {
                    '.html': 'text/html',
                    '.css':  'text/css',
                    '.js':   'application/javascript',
                    '.png':  'image/png',
                    '.jpg':  'image/jpeg',
                    '.jpeg': 'image/jpeg',
                    '.gif':  'image/gif',
                    '.svg':  'image/svg+xml',
                    '.ico':  'image/x-icon',
                    '.json': 'application/json',
                    '.woff': 'font/woff',
                    '.woff2': 'font/woff2',
                };
                res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
                res.end(data);
            } catch (e) {
                res.writeHead(404);
                res.end('Not found');
            }
        });

        server.listen(LOCAL_SERVER_PORT, '127.0.0.1', () => {
            console.log(`  Local server started on port ${LOCAL_SERVER_PORT} serving: ${directory}`);
            resolve(server);
        });

        server.on('error', reject);
    });
}

/**
 * Finds all index.html files in the Google-Drive repo clone,
 * returning their containing folder paths relative to the repo root.
 */
async function findDriveFolders(repoRoot) {
    const results = [];

    const categories = await fs.readdir(repoRoot, { withFileTypes: true });
    for (const category of categories) {
        if (!category.isDirectory() || category.name.startsWith('.')) continue;

        const categoryPath = path.join(repoRoot, category.name);
        const subfolders = await fs.readdir(categoryPath, { withFileTypes: true });

        for (const subfolder of subfolders) {
            if (!subfolder.isDirectory() || subfolder.name.startsWith('.')) continue;

            const subfolderPath = path.join(categoryPath, subfolder.name);
            const indexPath = path.join(subfolderPath, 'index.html');

            try {
                await fs.access(indexPath);
                // Store both the full local path and the relative repo path
                results.push({
                    localPath: subfolderPath,
                    repoPath: `${category.name}/${subfolder.name}`,
                });
            } catch {
                // No index.html in this subfolder, skip
            }
        }
    }

    console.log(`Found ${results.length} Drive folders with index.html.`);
    return results;
}

async function runModeLocal(browser) {
    // The Google-Drive repo will be checked out alongside Catalog_of_Repos
    // in the GitHub Actions workspace, or can be cloned fresh.
    const token = process.env.ORG_PAT_TOKEN;

    // Clone the Google-Drive repo into /tmp
    const driveRepoPath = path.join('/tmp', DRIVE_REPO_NAME);
    console.log(`\nCloning ${DRIVE_REPO_NAME} into ${driveRepoPath}...`);

    // Remove any previous clone
    await fs.rm(driveRepoPath, { recursive: true, force: true });

    const { execSync } = require('child_process');
    execSync(
        `git clone https://${token}@github.com/${TARGET_ORG}/${DRIVE_REPO_NAME}.git ${driveRepoPath}`,
        { stdio: 'inherit' }
    );

    const folders = await findDriveFolders(driveRepoPath);
    if (folders.length === 0) {
        console.log('No Drive folders found.');
        return;
    }

    for (const folder of folders) {
        console.log(`\n--- [Local] Processing ${folder.repoPath} ---`);

        let server;
        try {
            // Start a local server for this specific subfolder
            server = await startLocalServer(folder.localPath);

            const localUrl = `http://127.0.0.1:${LOCAL_SERVER_PORT}/`;
            const imageBuffer = await screenshotUrl(localUrl, browser);

            if (imageBuffer) {
                // Push preview.png into the subfolder path in the Google-Drive repo
                const previewRepoPath = `${folder.repoPath}/preview.png`;
                await pushPreviewToRepo(DRIVE_REPO_NAME, previewRepoPath, imageBuffer);
            }
        } catch (error) {
            console.error(`  ERROR: ${error.message}`);
        } finally {
            if (server) {
                server.close();
                console.log(`  Local server stopped.`);
            }
        }
    }
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────

async function main() {
    console.log(`\n=== Running in mode: ${RUN_MODE} ===\n`);

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

        if (RUN_MODE === 'local') {
            await runModeLocal(browser);
        } else {
            await runModePages(browser);
        }

    } catch (error) {
        console.error('Critical error:', error.message);
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
