# Role
You are a Senior Backend Engineer specializing in Web Scraping, Network Security, and Reverse Engineering.

# Objective
Generate a Node.js application designed to automate the discovery phase of "Smart Routing" project. The app must identify all external domains and paths a web-based game connects to, analyze JavaScript files for minified variable names, and store this intelligence in Redis to identify patterns across different games from the same vendor.

# Technical Architecture
##### 1. Headless Network Interceptor (Playwright)
- Action: Use Playwright (Chromium) to launch a provided "Game URL".
- Interception: Hook into the request event to capture every outgoing HTTP/HTTPS/WebSocket request.
- Filtering: * Ignore standard noise (Google Analytics, fonts, browser extensions).
    - Capture everything else, specifically targeting .js, .json, and /ws (WebSocket) endpoints.
- Data Collection: For every request, record the full URL, the headers (specifically Host and Accept-Encoding), and the request method.

##### 2. JavaScript Variable Analyzer
- Action: When a .js file is intercepted, the app should download the content.
- Logic: Perform a Regex-based search to identify "Smart Routing" targets.
    - Search for patterns like %variable%.server, %variable%.staticUrl, %variable%.api.
    - The goal is to identify if the variable name is n, d, e, etc., as seen in minified vendor code.
- Output: Return a list of candidate variables and the strings they are associated with.

##### 3. Redis Intelligence Layer
- Structure: Store data using a Vendor-based key system: vendor:{name}:paths and vendor:{name}:variables.
- Commonality Logic: * When a new Game URL is scanned, compare its discovered paths with the existing paths in Redis for that vendor.
    - Mark paths as "Static" (same across all games) or "Dynamic" (contains game-specific IDs or hashes).
- Nginx Generator Hint: Based on the commonality, suggest which paths should be location blocks and which should be body:gsub rules in Lua.

##### 4. Code Requirements
- Language: Node.js (Latest LTS).
- Libraries: playwright, ioredis, dotenv.
- Input: A CLI command or simple API where I pass vendor_name and game_url.
- Output: A JSON summary of all discovered domains and suggested "Surgical Replacements".

#### Instructions for Gemini CLI
- Initialize a project with a clean directory structure: /src, /scripts, /test.
- Implement a BrowserService using Playwright to handle the network sniffing.
- Implement a RegexService to scan for variable patterns in JS content.
- Implement a ComparisonService that pulls existing Redis data to identify vendor-level commonalities.
- Provide a README.md explaining how to run the scraper for a new game.
