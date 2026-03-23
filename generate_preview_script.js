const puppeteer = require('puppeteer');
const { promises: fs } = require('fs');
const path = require('path');
// This script requires Node.js v18+ for native fetch support

// --- Configuration ---
// Note: We use the organization name here, which is accounts-eles. 
const TARGET_ORG = 'accounts-eles';
// FIXED: Changed the base URL to point to the live deployed GitHub Pages URL.
// GitHub Pages URLs are case-insensitive, but typically lowercased (accounts-eles.github.io).
const GITHUB_PAGES_BASE_URL = `https://${TARGET_ORG.toLowerCase()}.github.io/`; 

const OUTPUT_DIR = path.join(__dirname, 'previews');
const THUMBNAIL_WIDTH = 1200;
const THUMBNAIL_HEIGHT = 800; // Height to capture the main repository header and some of the README
const SCREENSHOT_DELAY_MS = 3000; // 3 second delay to ensure the complex GitHub page has fully rendered

/**
 * Utility function to handle directory removal safely using native fs/promises.
 * @param {string} dirPath - The path to the directory to remove.
 */
async function removeDirectory(dirPath) {
    try {
        // Use recursive: true and force: true for robust cleanup in CI environment
        await fs.rm(dirPath, { recursive: true, force: true });
        console.log(`Successfully removed directory: ${dirPath}`);
    } catch (e) {
        // Log an error only if it's not simply "directory not found"
        if (e.code !== 'ENOENT') {
            console.error(`Error removing directory ${dirPath}:`, e.message);
        }
    }
}

/**
 * Fetches all public repository names accessible by the token user, then filters for the target user.
 * @returns {Promise<string[]>} An array of repository names belonging to TARGET_ORG.
 */
async function fetchRepositoryNames() {
    console.log(`Fetching all accessible repositories for the token user...`);
    
    // Get token from the environment variable
    const token = process.env.ORG_PAT_TOKEN;
    if (!token) {
        console.error("FATAL: ORG_PAT_TOKEN environment variable not set. Cannot fetch dynamic repository list.");
        return [];
    }

    const allRepoNames = [];
    let page = 1;
    let hasNextPage = true;
    
    while (hasNextPage) {
        // Fetch repositories associated with the authenticated user
        const url = `https://api.github.com/user/repos?per_page=100&page=${page}`;
        
        const headers = {
            'User-Agent': 'GitHub-Actions-Repo-Preview-Generator',
            'Authorization': `token ${token}`,
        };

        try {
            const response = await fetch(url, { headers });

            if (!response.ok) {
                throw new Error(`GitHub API HTTP error! Status: ${response.status} - ${response.statusText}`);
            }

            const data = await response.json();
            
            // Check for pagination link in the headers
            const linkHeader = response.headers.get('link');
            hasNextPage = linkHeader && linkHeader.includes('rel="next"');

            // Collect repository names, ensuring they belong to the correct user (accounts-eles)
            const names = data
                // CRITICAL FILTER: Ensure the repo belongs to the correct user (Daccounts-eles)
                .filter(repo => repo.owner.login === TARGET_ORG)
                // Filter out the current catalog repository
                .filter(repo => repo.name !== 'Catalog_of_Repos')
                .map(repo => repo.name);

            allRepoNames.push(...names);
            page++;

        } catch (error) {
            console.error(`ERROR fetching repository list: ${error.message}.`);
            hasNextPage = false; // Stop processing on error
        }
    }
    
    console.log(`Found ${allRepoNames.length} deployable repositories in ${TARGET_ORG}.`);
    return allRepoNames;
}

/**
 * Takes a screenshot by navigating to the live GitHub Pages URL.
 * @param {string} repoName - The name of the repository.
 * @param {puppeteer.Browser} browser - The active Puppeteer browser instance.
 */
async function processRepository(repoName, browser) {
    console.log(`\n--- Processing ${repoName} ---`);

    try {
        const page = await browser.newPage();
        
        // 1. Set the viewport size for the screenshot (matching the size we want to capture)
        await page.setViewport({ width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT });
        
        // 2. Construct the live GitHub Pages URL
        // Now using https://accounts-eles.github.io/repoName/
        const liveUrl = `${GITHUB_PAGES_BASE_URL}${repoName}/`;

        console.log(`Navigating to live URL: ${liveUrl}`);
        
        // 3. Navigate to the live URL and wait for the network to be mostly idle
        const response = await page.goto(liveUrl, {
            waitUntil: 'networkidle2', // Waits until there are no more than 2 pending network requests for at least 500ms.
            timeout: 60000 // 60 second timeout for potentially slow loads
        });

        if (!response || !response.ok()) {
             // Handle 404s or other non-successful HTTP statuses (e.g., if the Pages site isn't deployed)
             console.warn(`WARNING: Failed to load ${liveUrl}. Status: ${response ? response.status() : 'No response'}. Skipping screenshot.`);
             await page.close();
             return;
        }

        // 4. Wait for any remaining client-side JavaScript to render the page content
        console.log(`Waiting ${SCREENSHOT_DELAY_MS}ms for client-side rendering...`);
        // Use native Node.js Promise wrapper for reliable delay
        await new Promise(resolve => setTimeout(resolve, SCREENSHOT_DELAY_MS)); 

        // 5. Take Screenshot
        const outputPath = path.join(OUTPUT_DIR, `${repoName}.png`);

        console.log(`Taking screenshot and saving to ${outputPath}...`);
        await page.screenshot({ 
            path: outputPath, 
            fullPage: false, // Ensures we only capture the viewport defined above
            clip: { // Clip the screenshot to the desired size
                x: 0,
                y: 0,
                width: THUMBNAIL_WIDTH,
                height: THUMBNAIL_HEIGHT
            }
        });
        
        await page.close();
        console.log(`SUCCESS: Live application thumbnail saved for ${repoName}.`);

    } catch (error) {
        console.error(`FATAL ERROR processing ${repoName}:`, error.message);
    }
}

/**
 * Main execution function.
 */
async function main() {
    let browser;
    // We fetch repo names using the GitHub API
    const REPO_NAMES = await fetchRepositoryNames();

    if (REPO_NAMES.length === 0) {
        console.log('No repositories found. Exiting.');
        return;
    }

    try {
        // --- Setup ---
        console.log('Cleaning up previous screenshots and setting up output directory...');
        await removeDirectory(OUTPUT_DIR);
        await fs.mkdir(OUTPUT_DIR, { recursive: true });
        
        // --- Launch the Headless Browser ---
        console.log('Launching headless browser...');
        browser = await puppeteer.launch({ 
            headless: true, 
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage', 
                '--disable-gpu'
            ] 
        });

        // --- Processing Loop (Screenshot live deployed apps) ---
        for (const repoName of REPO_NAMES) {
            // Process the repository by navigating to its GitHub page
            await processRepository(repoName, browser);
        }
        
    } catch (error) {
        console.error('A critical error occurred during main execution:', error.message);
        process.exit(1);
    } finally {
        // --- Teardown ---
        if (browser) {
            await browser.close();
            console.log('Browser closed.');
        }
        console.log('\n--- Script finished ---');
    }
}

main();
