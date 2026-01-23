require('dotenv').config();
const RedisService = require('../src/services/RedisService');
const fs = require('fs');
const path = require('path');

function getGeneralizedPath(pathname) {
    const parts = pathname.split('/').filter(p => p && p.length > 0);
    const staticParts = [];

    for (const part of parts) {
        // A simple heuristic for dynamic parts:
        // - contains numbers and is long (e.g., user IDs, timestamps)
        // - looks like a hash (hex characters)
        // - is a UUID
        if (/\d/.test(part) && part.length > 6 || /[a-f0-9]{16,}/.test(part) || /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(part)) {
            break; // Stop at the first dynamic-looking part
        }
        staticParts.push(part);
    }

    if (staticParts.length === 0 && parts.length > 0) {
         // If the very first part is dynamic, use it to create a location block.
        return `/${parts[0]}`;
    }
    
    if (staticParts.length < parts.length) {
        // We found a dynamic part, so create a regex location
        const basePath = `/${staticParts.join('/')}`;
        return `~* ^${basePath}/.*`;
    }

    // All parts seem static, return the full path
    return `/${parts.join('/')}`;
}

async function generateConfig() {
    const args = process.argv.slice(2);
    if (args.length !== 2) {
        console.error('Usage: node scripts/generate-nginx.js <vendor_name> <proxy_domain>');
        process.exit(1);
    }

    const [vendor, proxyDomain] = args;
    const redis = new RedisService();

    try {
        const paths = await redis.getPaths(vendor);
        const variables = await redis.getVariables(vendor);

        // 1. Generate the Lua Gsub lines based on Redis variables
        let luaReplacements = `
                        -- Global Domain Replacement
                        local vendor_domain = "${proxyDomain}"
                        local proxy_host = ngx.var.http_host or "localhost:8080"

                        -- Escape dots for Lua pattern
                        local escaped_vendor = vendor_domain:gsub("%.", "%%.")

                        body = body:gsub("https://" .. escaped_vendor, "http://" .. proxy_host)
                        body = body:gsub("http://" .. escaped_vendor, "http://" .. proxy_host)
        `;

        // 2. Keep the specific variable replacements as a backup
        if (variables) {
            Object.entries(variables).forEach(([varName, associationData]) => {
                let associations = JSON.parse(associationData);
                if (typeof associations === 'string') associations = JSON.parse(associations);
                const assocArray = Array.isArray(associations) ? associations : [associations];

                assocArray.forEach(assoc => {
                    const pattern = `${varName}%.${assoc.property}`;
                    luaReplacements += `                -- Variable fallback: ${varName}.${assoc.property}\n`;
                    luaReplacements += `                body = body:gsub('${pattern}%%s*=%%s*["\'][^"\']+["\']', '${varName}.${assoc.property} = "' .. proxy_host .. '"')\n`;
                });
            });
        }

        // 2. Generate API Location Blocks using Variables
        let apiLocations = "";
        const uniquePaths = [...new Set(paths.map(p => getGeneralizedPath(new URL(p.url).pathname)))];

        uniquePaths.forEach(p => {
            apiLocations += `
                location ${p} {
                    set $upstream_target "${proxyDomain}";
                    proxy_pass https://$upstream_target;
                    proxy_set_header Host $upstream_target;
                    proxy_set_header X-Forwarded-Proto $scheme;
                }\n`;
            });

            // 3. The Full Template
            const fullConfig = `events {
            worker_connections 1024;
        }

        http {
            resolver 8.8.8.8 1.1.1.1 valid=300s;
            resolver_timeout 5s;

            server {
                listen 8080;
                server_name _;
                server_tokens off;

                proxy_ssl_server_name on;
                proxy_http_version 1.1;

                location = /health {
                    default_type text/plain;
                    return 200 "ok";
                }

                # 1. JS Interceptor Block
                location ~* ^/.*\\.js$ {
                    content_by_lua_block {
                        local http = require "resty.http"
                        local httpc = http.new()
                        local target_domain = "${proxyDomain}" 

                        local res, err = httpc:request_uri("https://" .. target_domain .. ngx.var.request_uri, {
                            method = "GET",
                            ssl_verify = false,
                            headers = {
                                ["Host"] = target_domain,
                                ["Accept-Encoding"] = "" 
                            }
                        })

                        if not res then
                            ngx.log(ngx.ERR, "Failed to fetch JS: ", err)
                            ngx.status = 502
                            ngx.say("Error")
                            return
                        end

                        local body = res.body
        ${luaReplacements}
                        ngx.header["Content-Type"] = "application/javascript"
                        ngx.say(body)
                    }
                } # END OF JS BLOCK

                # 2. API/Path Blocks (Now safely outside the JS block)
        ${apiLocations}

                # 3. Default proxy
                location / {
                    set $default_target "${proxyDomain}";
                    proxy_pass https://$default_target;
                    proxy_set_header Host $default_target;
                    proxy_set_header X-Forwarded-Proto $scheme;
                }
            }
        }
    `;

        const outputDir = path.join(__dirname, '../output', vendor);
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(path.join(outputDir, `nginx.conf`), fullConfig);

        console.log(`Success! Generated nginx.conf with startup-safety in: ${outputDir}`);

    } catch (error) {
        console.error('Generation failed:', error);
    } finally {
        await redis.disconnect();
    }
}

generateConfig();