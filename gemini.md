# Gemini Project: Smart Routing Sniffer

## 1. Objective
Create a Node.js application that automates the discovery and proxy configuration for complex, multi-domain web-based games. The final output must be a single, self-contained `nginx.conf` file that allows the game to be played seamlessly from a local server.

## 2. Core Architecture
The process is a two-step flow:
1.  **Sniffing & Caching:** A Node.js script launches a headless browser to capture all network activity and discover backend domains. This intelligence is stored in Redis.
2.  **Generation:** A second Node.js script reads the Redis cache and generates a single, optimized `nginx.conf` file.

---

### 2.1. Sniffer (`src/index.js`)
This script is the intelligence-gathering engine. It must be comprehensive to enable full automation.

*   **Input:** `node src/index.js <vendor_name> <game_url>`
*   **Actions:**
    1.  **Clear Cache:** Before starting, it will delete all existing Redis data for the specified `<vendor_name>` to ensure a clean run.
    2.  **Launch Browser:** It uses Playwright to launch a headless browser, navigating to the provided `<game_url>`.
    3.  **Comprehensive Interception:**
        *   It listens for standard network requests (`page.on('request'/'response')`).
        *   **Crucially**, it adds a dedicated listener for WebSockets (`page.on('websocket')`) to discover game engine or chat domains (e.g., `engine.livetables.io`).
    4.  **Deep Content Analysis:**
        *   It captures the content of all downloaded assets (HTML, JS, JSON).
        *   It scans the text content of these assets for any hardcoded absolute URLs (`https://...` or `wss://...`) to find domains that are not immediately requested.
    5.  **Variable Analysis:** It scans JavaScript files for patterns like `e.api = "..."` to identify dynamic API endpoints.
*   **Redis Output:**
    *   `vendor:{name}:metadata`: Stores the **Primary Domain** (extracted from the initial `<game_url>`).
    *   `vendor:{name}:paths`: A set of all unique request paths and their original hostnames.
    *   `vendor:{name}:domains`: A set of all unique hostnames discovered through network interception and deep content analysis.
    *   `vendor:{name}:variables`: A hash of discovered variable names and their associated properties.

### 2.2. NGINX Generator (`scripts/generate-nginx.js`)
This script creates the final, self-contained proxy configuration.

*   **Input:** `node scripts/generate-nginx.js <vendor_name>`
*   **Actions:**
    1.  **Fetch Intelligence:** It reads all data for the `<vendor_name>` from Redis (`metadata`, `paths`, `domains`, `variables`).
    2.  **Domain Logic:** It identifies the `primaryDomain` from the metadata and compiles a list of all other unique `secondaryDomains`.
    3.  **Generate `nginx.conf`:** It constructs a single configuration file with the following features:
        *   **Path-Based Routing:** For each unique path discovered, it generates a specific `location /path/to/asset { ... }` block that `proxy_pass`es the request to the correct upstream host.
        *   **Fallback to Primary:** A root `location / { ... }` acts as a fallback, proxying any unknown paths to the `primaryDomain`.
        *   **Shield Script Injection (Robust):**
            *   Instead of complex inline escaping, the "Shield" JavaScript (responsible for client-side URL rewriting) is served from a dedicated internal location: `location = /__shield.js`.
            *   This location uses `content_by_lua_block` with Lua's long-bracket syntax `[==[ ... ]==]` to safely serve the script without escaping issues.
            *   A `sub_filter` directive injects `<script src='/__shield.js'></script>` into the `<head>` of HTML responses.
        *   **Static Replacements:** It uses `sub_filter` to iterate through *all* discovered domains and replace them with the proxy's address (`$http_host`) in HTML, JS, and JSON responses.
        *   **Header Cleaning:** It uses `header_filter_by_lua_block` to remove `Content-Length` (to prevent truncation after modification) and security headers like `Content-Security-Policy` and `X-Frame-Options` (to allow iframe usage).

This architecture ensures that **no manual domain input is required** and the output is a **single, deployable `nginx.conf` file**.