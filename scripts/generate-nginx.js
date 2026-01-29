require('dotenv').config();
const RedisService = require('../src/services/RedisService');
const fs = require('fs');
const path = require('path');

// This function is no longer needed for the new architecture
// function getGeneralizedPath(pathname) { ... }

function findTargetDomain(paths) {
    if (!paths || paths.length === 0) return null;
    const hostCounts = new Map();
    paths.forEach(p => {
        try {
            const host = new URL(p.url).hostname;
            hostCounts.set(host, (hostCounts.get(host) || 0) + 1);
        } catch (e) {
            // Ignore invalid URLs
        }
    });
    if (hostCounts.size === 0) return null;
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

    const [vendor] = args;
    const redis = new RedisService();

    try {
        const paths = await redis.getPaths(vendor);
        const variables = await redis.getVariables(vendor);
        const proxyDomain = findTargetDomain(paths);

        if (!proxyDomain) {
            console.error(`Could not determine target domain for vendor "${vendor}".`);
            process.exit(1);
        }
        console.log(`Auto-detected Target Domain for ${vendor}: ${proxyDomain}`);

        const shieldScript = `
<script>
(function() {
  'use strict';
  if (window.__proxy_shield_active) return;
  window.__proxy_shield_active = true;
  const proxyHost = window.location.host;
  const vendorDomain = "${proxyDomain}";
  window.__webpack_public_path__ = 'http://' + proxyHost + '/';
  const fixUrl = (url) => {
    if (typeof url !== 'string' || !url) return url;
    return url.replace(new RegExp('https?:\\/\\/' + vendorDomain.replace(/\\./g, '\\.'), 'g'), 'http://' + proxyHost);
  };
  const originalFetch = window.fetch;
  window.fetch = function(input, opts) {
    const urlToFix = typeof input === 'string' ? input : (input && input.url);
    return originalFetch(fixUrl(urlToFix) || input, opts);
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    return originalOpen.call(this, method, fixUrl(url), ...args);
  };
  if (window.importScripts) {
    const originalImportScripts = window.importScripts;
    window.importScripts = function(...urls) {
      return originalImportScripts.apply(this, urls.map(fixUrl));
    };
  }
  const blockRedirect = (url) => { console.log('Blocked redirect to:', url); return false; };
  window.location.replace = blockRedirect;
  window.location.assign = blockRedirect;
  try {
    const originalHref = window.location.href;
    Object.defineProperty(window.location, 'href', { set: blockRedirect, get: () => originalHref });
  } catch(e) {}
})();
</script>
`;

        let jsBodyLua = `
                        local vendor_domain = "${proxyDomain}"
                        local proxy_host = ngx.var.http_host or "localhost:8080"
                        local escaped_vendor = vendor_domain:gsub("%.", "%%.")
                        if body and string.len(body) > 0 then
                            body = body:gsub("https://" .. escaped_vendor, "http://" .. proxy_host)
                            body = body:gsub("http://" .. escaped_vendor, "http://" .. proxy_host)
        `;
        if (variables) {
            Object.entries(variables).forEach(([varName, associationData]) => {
                const associations = JSON.parse(associationData);
                associations.forEach(assoc => {
                    // CRITICAL FIX: Escape Lua magic characters in the variable name
                    const escapedVarName = varName.replace(/([().%+-^*?[\]])/g, "%$1");
                    const luaVarPath = `${escapedVarName}%.${assoc.property}`;
                    
                    // Use a safer pattern match string
                    jsBodyLua += `                    body = body:gsub('${luaVarPath}%%s*=%%s*["\\'][^"\\']+["\\']', '${varName}.${assoc.property} = "http://" .. proxy_host')\n`;
                });
            });
        }
        jsBodyLua += `              end`;

        let apiLocations = "";
        const uniquePaths = [...new Set(paths.map(p => new URL(p.url).pathname))]
            .filter(p => p !== '/' && !p.match(/\.(js|png|jpg|jpeg|gif|webp|woff|woff2|ttf|svg|mp3|ogg|wav|json|ico)$/i));
        uniquePaths.forEach(p => {
            apiLocations += `
                location "${p}" {
                    proxy_pass https://vendor_backend;
                    proxy_ssl_name ${proxyDomain};
                    proxy_ssl_server_name on;
                    proxy_set_header Host ${proxyDomain};
                    proxy_set_header Origin "https://${proxyDomain}";
                    proxy_set_header Referer "https://${proxyDomain}/";
                    proxy_cookie_domain ${proxyDomain} $host;
                    proxy_http_version 1.1;
                    proxy_set_header Connection "";
                }
`;
        });

        const fullConfig = `
        worker_processes auto;
        events {
            worker_connections 4096;
            use epoll;
            multi_accept on;
        }
        http {
            resolver 1.1.1.1 8.8.8.8 valid=300s;
            resolver_timeout 5s;
            
            upstream vendor_backend {
                server ${proxyDomain}:443;
                keepalive 64;
            }

            proxy_buffer_size   512k;
            proxy_buffers   16 512k;
            proxy_busy_buffers_size   1024k;
            proxy_max_temp_file_size 0;
            proxy_connect_timeout 10s;
            proxy_send_timeout 60s;
            proxy_read_timeout 60s;

            server {
                listen 8080;
                server_name _;

                location ~* \.(png|jpg|jpeg|gif|webp|woff|woff2|ttf|svg|mp3|ogg|wav|json|ico)$ {
                    proxy_pass https://vendor_backend;
                    proxy_ssl_name ${proxyDomain};
                    proxy_ssl_server_name on;
                    proxy_set_header Host ${proxyDomain};
                    proxy_set_header Referer "https://${proxyDomain}/";
                    proxy_http_version 1.1;
                    proxy_set_header Connection "";
                    add_header Cache-Control "public, max-age=3600" always;
                }

                location ~* \.js$ {
                    content_by_lua_block {
                        local http = require "resty.http"
                        local httpc = http.new()
                        httpc:set_timeout(30000)
                        local client_ua = ngx.var.http_user_agent or "Mozilla/5.0"
                        
                        local res, err = httpc:request_uri("https://${proxyDomain}" .. ngx.var.request_uri, {
                            method = "GET",
                            ssl_verify = false,
                            headers = {
                                ["Host"] = "${proxyDomain}",
                                ["Referer"] = "https://${proxyDomain}/",
                                ["User-Agent"] = client_ua,
                                ["Accept"] = "*/*",
                                ["Accept-Encoding"] = "" 
                            },
                            keepalive_timeout = 60000,
                            keepalive_pool = 64
                        })

                        if not res then
                            ngx.status = 502; ngx.say("/* Proxy Error: " .. (err or "unknown") .. " */"); return
                        end
                        if res.status >= 400 then
                             ngx.status = res.status; ngx.say("/* Vendor Error: " .. res.status .. " */"); return
                        end
                        
                        local body = res.body
                        ${jsBodyLua}
                        
                        ngx.header["Content-Type"] = "application/javascript"
                        ngx.header["X-Content-Type-Options"] = "nosniff"
                        ngx.header["Access-Control-Allow-Origin"] = "*"
                        ngx.header["Cache-Control"] = "public, max-age=3600"
                        ngx.say(body)
                    }
                }

                ${apiLocations}

                location / {
                    proxy_pass https://vendor_backend;
                    proxy_ssl_name ${proxyDomain};
                    proxy_ssl_server_name on;
                    proxy_set_header Host ${proxyDomain};
                    proxy_set_header Accept-Encoding ""; 
                    proxy_cookie_domain ${proxyDomain} $host;
                    proxy_redirect https://${proxyDomain}/ /;

                    header_filter_by_lua_block {
                        ngx.header["Content-Security-Policy"] = nil
                        ngx.header["X-Frame-Options"] = nil
                        ngx.header["X-Content-Type-Options"] = nil
                    }

                    body_filter_by_lua_block {
                        local chunk = ngx.arg[1]
                        local eof = ngx.arg[2]
                        local buffered = ngx.ctx.buffered or ""
                        if chunk then buffered = buffered .. chunk end
                        if eof then
                            local vendor_domain = "${proxyDomain}"
                            local proxy_host = ngx.var.http_host or "localhost:8080"
                            local escaped_vendor = vendor_domain:gsub("%.", "%%.")

                            if buffered then
                                buffered = buffered:gsub("https://" .. escaped_vendor, "http://" .. proxy_host)
                                buffered = buffered:gsub("http://" .. escaped_vendor, "http://" .. proxy_host)
                            end

                            local shield = [[${shieldScript}]]
                            if buffered and buffered:find("<head>") then
                                buffered = buffered:gsub("<head>", "<head>" .. shield)
                            elseif buffered and buffered:find("<HTML>") then
                                buffered = buffered:gsub("<HTML>", "<HTML>" .. shield)
                            end
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

        console.log(`✅ Success! Generated new architecture nginx.conf.`);

    } catch (error) {
        console.error('Generation failed:', error);
    } finally {
        await redis.disconnect();
    }
}

generateConfig();
