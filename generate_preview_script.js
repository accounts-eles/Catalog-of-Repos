name: Generate Repository Social Preview Card

# Define the events that trigger this workflow
on:
  push:
    branches:
      - main
  workflow_dispatch: # Allows manual triggering from the GitHub UI

# The 'jobs' section defines the work to be done
jobs:
  generate_preview_card:
    # prevents an infinite loop when the action commits the new files.
    if: github.actor != 'github-actions[bot]'

    runs-on: ubuntu-latest
    
    permissions:
      # Required to commit the generated files back to the repo
      contents: write

    steps:
      - name: Checkout repository code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm' # Speeds up subsequent runs
          
      - name: Install Chromium System Dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libxkbcommon-x11-0 libgbm-dev libasound2t64
          
      - name: Install Node Dependencies
        run: npm ci

      # --- CRITICAL FIX: Explicitly install the Chrome binary for Puppeteer ---
      - name: Install Puppeteer Browser
        run: npx puppeteer browsers install chrome

      # --- STEP A: Run the image generation script ---
      - name: Generate Preview Image via Node.js Script
        run: node generate_preview_script.js
        env:
          ORG_PAT_TOKEN: ${{ secrets.ORG_PAT_TOKEN }} 

      # --- STEP B: Commit and Push the New Files ---
      - name: Check for changes and commit
        id: commit
        uses: stefanzweifel/git-auto-commit-action@v5
        with:
          commit_message: 'docs: Auto-generated social media preview cards'
          # This ensures it picks up everything in the previews folder
          file_pattern: 'previews/*.png'
          # Optional: ensures the action uses the correct git identity
          commit_author: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>

      - name: Report Status
        if: steps.commit.outputs.changes_detected == 'true'
        run: echo "Successfully generated and committed preview files to the previews/ directory."

      - name: Report No Changes
        if: steps.commit.outputs.changes_detected == 'false'
        run: echo "No changes detected
