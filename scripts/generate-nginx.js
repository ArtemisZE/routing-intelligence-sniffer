require('dotenv').config();
const RedisService = require('../src/services/RedisService');
const fs = require('fs');
const path = require('path');

function getGeneralizedPath(pathname) {
    const parts = pathname.split('/').filter(p => p && p.length > 0);
    const staticParts = [];

    for (const part of parts) {
        if (/\d/.test(part) && part.length > 6 || /[a-f0-9]{16,}/.test(part) || /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(part)) {
            break; 
        }
        staticParts.push(part);
    }

    if (staticParts.length === 0 && parts.length > 0) return `/${parts[0]}`;
    if (staticParts.length < parts.length) {
        const basePath = `/${staticParts.join('/')}`;
        return `~* ^${basePath}/.*`;
    }
    return `/${parts.join('/')}`;
}

function findTargetDomain(paths) {
    if (!paths || paths.length === 0) {
        return null;
    }

    const hostCounts = new Map();

    paths.forEach(p => {
        try {
            const host = new URL(p.url).hostname;
            hostCounts.set(host, (hostCounts.get(host) || 0) + 1);
        } catch (e) {
            console.error(`Skipping invalid URL in paths: ${p.url}`);
        }
    });

    if (hostCounts.size === 0) {
        return null;
    }

    let maxCount = 0;
    let dominantHost = '';

    for (const [host, count] of hostCounts.entries()) {
        if (count > maxCount) {
            maxCount = count;
            dominantHost = host;
        }
    }

    return dominantHost;
}

async function generateConfig() {
    const args = process.argv.slice(2);
    if (args.length !== 1) {
        console.error('Usage: node scripts/generate-nginx.js <vendor_name>');
        process.exit(1);
    }

    const [vendor, proxyDomain] = args;
    const redis = new RedisService();

    try {
        const paths = await redis.getPaths(vendor);
        const variables = await redis.getVariables(vendor);

        const proxyDomain = findTargetDomain(paths);  
        if (!proxyDomain) {
            console.error(`Could not determine target domain for vendor "${vendor}".`);
            console.error('Please run the sniffer first (\`node src/index.js ...\`) to gather path data.');
            process.exit(1);
        }

        console.log(`Auto-detected Target Domain for ${vendor}: ${proxyDomain}`);

        // ---------------------------------------------------------
        // 1. JS Surgery Logic (Variable Replacements)
        // ---------------------------------------------------------
        let luaJsReplacements = `
                        local vendor_domain = "${proxyDomain}"
                        local proxy_host = ngx.var.http_host or "localhost:8080"
                        local escaped_vendor = vendor_domain:gsub("%.", "%%.")

                        body = body:gsub("https://" .. escaped_vendor, "http://" .. proxy_host)
                        body = body:gsub("http://" .. escaped_vendor, "http://" .. proxy_host)
        `;

        if (variables) {
            Object.entries(variables).forEach(([varName, associationData]) => {
                let associations = JSON.parse(associationData);
                if (typeof associations === 'string') associations = JSON.parse(associations);
                const assocArray = Array.isArray(associations) ? associations : [associations];

                assocArray.forEach(assoc => {
                    const luaVarPath = `${varName}%.${assoc.property}`;
                    luaJsReplacements += `                        body = body:gsub('${luaVarPath}%%s*=%%s*["\\'][^"\\']+["\\']', '${varName}.${assoc.property} = "http://" .. proxy_host')\n`;
                });
            });
        }

        // ---------------------------------------------------------
        // 2. HTML Surgery Logic (The "Anti-Redirect" Block)
        // ---------------------------------------------------------
        // We use a safe wrapper to avoid breaking the page syntax
        let luaHtmlReplacements = `
                        local vendor = "${proxyDomain}"
                        local proxy = ngx.var.http_host or "localhost:8080"
                        local escaped_vendor = vendor:gsub("%.", "%%.")

                        -- 1. Replace Domains
                        buffered = buffered:gsub("https://" .. escaped_vendor, "http://" .. proxy)
                        
                        -- 2. KILL REDIRECTS (The "Void" Technique)
                        -- Instead of console.log, we replace the setter with a dummy operation
                        -- Matches: window.location.href = "..."
                        buffered = buffered:gsub("window%.location%.href%s*=", "var blocked_redirect = ")
                        buffered = buffered:gsub("window%.top%.location%.href%s*=", "var blocked_top_redirect = ")
                        
                        -- Matches: window.location.replace("...")
                        buffered = buffered:gsub("window%.location%.replace", "console.log")
        `;

        // ---------------------------------------------------------
        // 3. Generate API Location Blocks
        // ---------------------------------------------------------
        let apiLocations = "";
        const uniquePaths = [...new Set(paths.map(p => getGeneralizedPath(new URL(p.url).pathname)))];

        uniquePaths.forEach(p => {
            apiLocations += `
                location ${p} {
                    set $upstream_target "${proxyDomain}";
                    proxy_pass https://$upstream_target;
                    
                    proxy_set_header Host $upstream_target;
                    proxy_set_header X-Forwarded-Proto $scheme;
                    proxy_cookie_domain $upstream_target $host;
                }\n`;
            });

        // ---------------------------------------------------------
        // 4. The Final Nginx Config
        // ---------------------------------------------------------
            const fullConfig = `events {
            worker_connections 1024;
        }

        http {
            resolver 8.8.8.8 1.1.1.1 valid=300s;
            resolver_timeout 5s;
            
            # Increase buffer size for large headers/cookies
            proxy_buffer_size   128k;
            proxy_buffers   4 256k;
            proxy_busy_buffers_size   256k;

            server {
                listen 8080;
                server_name _;
                server_tokens off;

                proxy_ssl_server_name on;
                proxy_http_version 1.1;

                location = /health {
                    return 200 "ok";
                }

                # 1. JS Interceptor
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
                            ngx.status = 502
                            ngx.say("Error fetching JS")
                            return
                        end

                        local body = res.body
${luaJsReplacements}
                        ngx.header["Content-Type"] = "application/javascript"
                        ngx.say(body)
                    }
                }

                # 2. Specific API Blocks
${apiLocations}

                # 3. HTML Interceptor (Root & Everything Else)
                location / {
                    set $upstream_target "${proxyDomain}";
                    proxy_pass https://$upstream_target;
                    
                    # Pass headers correctly
                    proxy_set_header Host $upstream_target;
                    proxy_set_header X-Forwarded-Proto $scheme;
                    
                    # Ensure we can read the body to modify it (disable compression from server)
                    proxy_set_header Accept-Encoding "";

                    # Handle Cookies so login works
                    proxy_cookie_domain $upstream_target $host;
                    proxy_cookie_path / /;

                    # Strip Security Headers that block iframe/proxying
                    header_filter_by_lua_block {
                        ngx.header["Content-Security-Policy"] = nil
                        ngx.header["X-Frame-Options"] = nil
                        ngx.header["X-Content-Type-Options"] = nil
                    }

                    # Modify HTML on the fly
                    body_filter_by_lua_block {
                        local chunk = ngx.arg[1]
                        local eof = ngx.arg[2]
                        local buffered = ngx.ctx.buffered or ""
                        
                        if chunk then
                            buffered = buffered .. chunk
                        end
                        
                        if eof then
                            ${luaHtmlReplacements}
                            ngx.arg[1] = buffered
                        else
                            ngx.arg[1] = nil
                        end
                        ngx.ctx.buffered = buffered
                    }
                }
            }
        }
    `;

        const outputDir = path.join(__dirname, '../output', vendor);
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(path.join(outputDir, `nginx.conf`), fullConfig);

        console.log(`✅ Success! Generated nginx.conf with Stream-Based Surgery.`);

    } catch (error) {
        console.error('Generation failed:', error);
    } finally {
        await redis.disconnect();
    }
}

generateConfig();