# MikroTik Polling Agent for SAFE_Links
# This script should be pasted into the router's terminal or run via /import

# Replace these with your backend URL and the router's unique API key
:local backendUrl "https://your-backend-url.com/api/router/poll"
:local routerApiKey "YOUR_ROUTER_API_KEY"

# Create a scheduler that runs every 30 seconds
/system scheduler add name="safe-links-poll" interval=30s on-event={
    :local response ([/tool fetch url=($backendUrl . "?key=" . $routerApiKey) as-value output=user])
    :if ([:len $response] > 0) do={
        :local commands ([:deserialize from=json value=$"response"])
        :foreach cmd in=$commands do={
            :if ($cmd->"action" = "create_user") do={
                /ip hotspot user add name=($cmd->"username") password=($cmd->"password") profile=($cmd->"profile")
            }
            :if ($cmd->"action" = "disable_user") do={
                /ip hotspot user disable [find name=($cmd->"username")]
            }
            :if ($cmd->"action" = "enable_user") do={
                /ip hotspot user enable [find name=($cmd->"username")]
            }
        }
    }
}
