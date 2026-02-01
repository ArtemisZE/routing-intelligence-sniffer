# Routing Intelligence Sniffer & NGINX Generator

This project automates the discovery of external domains, paths, and dynamic variables for complex web-based games and generates a self-contained NGINX configuration to proxy them seamlessly.

## 1. Setup

1.  **Install Dependencies:**
    ```bash
    npm install
    ```

2.  **Install Playwright browsers:**
    ```bash
    npx playwright install
    ```

3.  **Configure Environment:**
    Create a `.env` file in the root:
    ```
    REDIS_URL=redis://127.0.0.1:6379
    ```

4.  **Ensure Redis is running:**
    The application relies on Redis for storing discovered intelligence.

## 2. Usage

### Step 1: Sniffing (Intelligence Gathering)
Runs a headless browser to capture network traffic, hidden domains, and potential API variables.

```bash
node src/index.js <vendor_name> <game_url>
```
*   `<vendor_name>`: Unique ID for the game provider (e.g., `ezugi`).
*   `<game_url>`: The full URL where the game is hosted.

**Example:**
```bash
node src/index.js ezugi "https://example.com/play/blackjack"
```

### Step 2: Generation (Config Creation)
Generates a complete `nginx.conf` based on the data stored in Redis.

```bash
node scripts/generate-nginx.js <vendor_name>
```

**Output:**
The file is saved to `output/<vendor_name>/nginx.conf`.

---

## 3. Data Structure (Redis)

The sniffer categorizes discovered data into four specific Redis keys per vendor. This intelligence is what drives the "Smart Routing" capabilities of the generated NGINX config.

### 1. `vendor:{name}:metadata` (Hash)
*   **Purpose:** Stores high-level information about the session.
*   **Key Fields:**
    *   `primaryDomain`: The main domain hosting the game application (e.g., `lobby.example.com`).
*   **Usage:** Used as the default `proxy_pass` target for the fallback `location /` block.

### 2. `vendor:{name}:domains` (Set)
*   **Purpose:** A comprehensive list of *all* unique hostnames discovered.
*   **Sources:**
    *   Network requests (XHR, Fetch, WebSocket).
    *   Deep content scanning (regex on HTML/JS/JSON responses).
*   **Usage:** 
    *   Used to generate the global `sub_filter` rules that replace *all* occurrences of these domains with your proxy's address (`$http_host`).
    *   Used to generate the client-side "Shield" script that intercepts `window.fetch`, `XHR`, and `WebSocket` to rewrite URLs on the fly.

### 3. `vendor:{name}:paths` (Set)
*   **Purpose:** A registry of specific URL paths and which backend server they belong to.
*   **Format:** JSON objects containing `{ "url": "...", "host": "..." }`.
*   **Usage:** 
    *   Used to generate precise `location = /specific/path { ... }` blocks.
    *   This is critical for "Split Routing": if `/api/v1` goes to `server A` but `/socket.io` goes to `server B`, this data ensures the proxy routes them correctly despite them sharing the same root domain in the proxy.

### 4. `vendor:{name}:variables` (Hash)
*   **Purpose:** Stores discovered JavaScript variable names that likely hold configuration URLs.
*   **Format:** `variableName` -> `associations` (JSON).
*   **Example:** `e.api` might be identified because it was assigned a URL string.
*   **Usage:** 
    *   Used to create targeted Lua replacement rules.
    *   Instead of just replacing the string `https://api.game.com`, we can inject logic to replace the assignment `e.api = "..."` directly, ensuring the game initializes with our proxy URL even if the domain is obfuscated or dynamically constructed.