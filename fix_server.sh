#!/bin/bash
FILE="/etc/nginx/sites-available/tradeictearner.online"
if ! grep -q "location /socket.io/" "$FILE"; then
  sudo python3 -c '
import sys
lines = open(sys.argv[1]).readlines()
out = []
for line in lines:
    if "location /api/" in line:
        out.append("    location /socket.io/ {\n        proxy_pass http://localhost:5000;\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection \"upgrade\";\n        proxy_set_header Host $host;\n    }\n")
    out.append(line)
open("temp_nginx", "w").writelines(out)
' "$FILE"
  sudo mv temp_nginx "$FILE"
  sudo nginx -t && sudo systemctl reload nginx
fi
npm run build
pm2 restart all
