# Routing Intelligence Sniffer

This application automates the discovery of external domains and paths that a web-based game connects to. It analyzes JavaScript files for minified variable names and stores this information in Redis to identify patterns across different games from the same vendor.

## Setup

1.  **Install Dependencies:**
    ```bash
    npm install
    ```

2.  **Install Playwright browsers:**
    ```bash
    npx playwright install
    ```

3.  **Configure Environment:**
    Create a `.env` file in the root of the project and add your Redis connection URL:
    ```
    REDIS_URL=redis://127.0.0.1:6379
    ```

4.  **Ensure Redis is running:**
    This application requires a running Redis instance. Make sure your local Redis server is up and running on the configured port.

## Usage

To run the scraper, use the following command, providing a vendor name and the URL of the game to be scanned:

```bash
node src/index.js <vendor_name> <game_url>
```

-   `<vendor_name>`: A unique identifier for the game vendor (e.g., `supercell`).
-   `<game_url>`: The full URL of the web-based game.

### Example

```bash
node src/index.js my-game-vendor "http://example.com/game"
```

### Output

The application will output a JSON summary to the console containing:
-   A list of all discovered domains and paths.
-   A list of potential "Smart Routing" variables found in the JavaScript files.
-   An analysis of which paths are static, dynamic, or new compared to previous scans for the same vendor.
-   Suggestions for Nginx `location` blocks and `gsub` rules.
