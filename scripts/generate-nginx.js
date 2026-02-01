require('dotenv').config();
const RedisService = require('../src/services/RedisService');
const fs = require('fs');
const path = require('path');

async function generateConfig() {
    const args = process.argv.slice(2);
    const vendor = args[0];
    
    if (!vendor) {
        console.error('Usage: node scripts/generate-nginx.js <vendor_name>');
        process.exit(1);
    }

    const redis = new RedisService();

    try {
        const paths = await redis.getPaths(vendor);
        const discoveredDomains = await redis.getDomains(vendor);
        const metadata = await redis.redis.hgetall(`vendor:${vendor}:metadata`);
        const variables = await redis.getVariables(vendor);

        const hostMap = new Map(); 
        const allHosts = new Set();
        if (discoveredDomains) discoveredDomains.forEach(d => allHosts.add(d));

        paths.forEach(p => {
            try {
                const u = new URL(p.url);
                hostMap.set(u.pathname, u.hostname); 
                allHosts.add(u.hostname);
            } catch (e) {}
        });

        if (allHosts.size === 0) {
            console.error(`No domains for vendor "${vendor}". Run sniffer first.`);
            process.exit(1);
        }

        let primaryDomain = metadata.primaryDomain || [...allHosts][0];
        console.log(`Primary Domain: ${primaryDomain}`);
        console.log(`Detected Domains:`, [...allHosts]);

        // --- 1. Construct Dynamic JS Shield ---
        // This logic is generic: it takes the list of domains and creates JS replace rules.
        let jsReplaceLogic = 'let s=u;if(typeof u!=="string")return u;';
        allHosts.forEach(h => {
            const escaped = h.replace(/\./g, '\\.');
            jsReplaceLogic += `s=s.replace(new RegExp('https?:\\/\\/${escaped}','g'),'https://'+h);`;
            jsReplaceLogic += `s=s.replace(new RegExp('wss?:\\/\\/${escaped}','g'),'wss://'+h);`;
        });
        jsReplaceLogic += `return s;`;

        // The actual Shield Script (Minified to be safe inside NGINX config)
        // We inline this directly into the sub_filter to keep the config self-contained.
        // We serve the shield script via a dedicated location using Lua to avoid NGINX escaping hell.
        // The script is embedded in the config inside a content_by_lua_block.
        const shieldScript = `
        (function(){
        'use strict';
        if(window.__ps)return;window.__ps=true;
        const h=window.location.host;
        window.__webpack_public_path__='https://'+h+'/';
        const fx=u=>{${jsReplaceLogic}};
        const oF=window.fetch;window.fetch=(i,o)=>{const u=typeof i==='string'?i:(i&&i.url);return oF(fx(u)||i,o);};
        const oX=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u,...a){return oX.call(this,m,fx(u),...a);};
        const oW=window.WebSocket;window.WebSocket=function(u,p){return new oW(fx(u),p);};
        })();`.replace(/\n/g, ''); // Minify slightly by removing newlines

        // --- 2. Construct NGINX sub_filters ---
        // These handle the static HTML/JS text replacements on the server side.
        let subFilters = 'sub_filter_once off; sub_filter_types *;';
        
        // Inject Shield via src attribute (cleaner and safer)
        subFilters += ` sub_filter "<head>" "<head><script src='/__shield.js'></script>";`;

        // Domain Replacements
        allHosts.forEach(h => {
            subFilters += ` sub_filter "https://${h}" "https://$http_host";`;
            subFilters += ` sub_filter "http://${h}" "https://$http_host";`;
            subFilters += ` sub_filter "wss://${h}" "wss://$http_host";`;
            subFilters += ` sub_filter "ws://${h}" "wss://$http_host";`;
        });

        // --- 3. Construct Location Blocks ---
        // Maps specific paths to their specific origin servers.
        let locationBlocks = "";
        const uniquePaths = [...hostMap.keys()].filter(p => p !== '/');
        
        uniquePaths.forEach(p => {
            const target = hostMap.get(p);
            locationBlocks += `
                location = "${p}" {
                    proxy_pass https://${target};
                    proxy_ssl_name ${target};
                    proxy_ssl_server_name on;
                    proxy_set_header Host ${target};
                    proxy_set_header Origin "https://${target}";
                    proxy_set_header Referer "https://${target}/";
                    proxy_set_header Accept-Encoding ""; 
                    proxy_cookie_domain ${target} $host;
                    proxy_http_version 1.1;
                    proxy_set_header Upgrade $http_upgrade;
                    proxy_set_header Connection "Upgrade";
                }
            `;
        });

        // --- 4. Final NGINX Config ---
        const fullConfig = `
        worker_processes auto;
        events { worker_connections 4096; }
        http {
            resolver 1.1.1.1 8.8.8.8 valid=300s;
            map $http_upgrade $connection_upgrade { default upgrade; '' close; }

            server {
                listen 80;
                listen 443 ssl http2;
                server_name _;

                ssl_certificate /etc/nginx/certs/cert.pem;
                ssl_certificate_key /etc/nginx/certs/key.pem;

                # Global Settings
                proxy_http_version 1.1;
                proxy_set_header Upgrade $http_upgrade;
                proxy_set_header Connection $connection_upgrade;
                
                # Apply text replacements (Static & Shield)
                ${subFilters}
                
                # SERVE SHIELD SCRIPT (Self-contained via Lua)
                location = /__shield.js {
                    default_type application/javascript;
                    content_by_lua_block {
                        ngx.say([==[${shieldScript}]==])
                    }
                }

                # Path-Based Routing
                ${locationBlocks}

                # Fallback / Root
                location / {
                    proxy_pass https://${primaryDomain};
                    proxy_ssl_name ${primaryDomain};
                    proxy_ssl_server_name on;
                    proxy_set_header Host ${primaryDomain};
                    proxy_set_header Accept-Encoding "";
                    proxy_cookie_domain ${primaryDomain} $host;

                    # Header Cleaning
                    header_filter_by_lua_block { 
                        ngx.header["Content-Length"] = nil 
                        ngx.header["Content-Security-Policy"] = nil
                        ngx.header["X-Frame-Options"] = nil
                        ngx.header["Accept-Ranges"] = nil
                    }
                }
            }
        }
        `;

        const outputDir = path.join(__dirname, '../output', vendor);
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
        
        fs.writeFileSync(path.join(outputDir, `nginx.conf`), fullConfig);
        
        // Remove old external files to avoid confusion
        if (fs.existsSync(path.join(outputDir, `shield.js`))) fs.unlinkSync(path.join(outputDir, `shield.js`));
        if (fs.existsSync(path.join(outputDir, `replacements.lua`))) fs.unlinkSync(path.join(outputDir, `replacements.lua`));

        console.log(`Generated nginx.conf for vendor "${vendor}" at ${outputDir}/nginx.conf.`);

    } catch (error) {
        console.error('Generation failed:', error);
    } finally {
        await redis.disconnect();
    }
}

generateConfig();
