package com.aibrainsventures.safelinks;

import java.util.regex.Pattern;

/**
 * Java port of the RouterOsScripts logic originally written for the
 * standalone Kotlin/WebView Android app (see that project's own
 * RouterOsScripts.kt for the fuller design writeup). Ported here
 * because this Capacitor-based app's native layer is plain Java, not
 * Kotlin — behavior is identical, just the language changed.
 *
 * Faithfully ports the LOGIC of
 * reslink-backend/router-scripts/reslink-agent.rsc — same HTTP calls,
 * same response parsing, same hotspot-user command handling, same
 * credential persistence. Verified structurally consistent with the
 * Node.js port of this same logic (desktop-app/src/native/routerOsScripts.js),
 * which was itself verified by actually diffing its generated output
 * against reslink-agent.rsc directly — this file couldn't be verified
 * that same way (no JVM available in the environment this was built
 * in), so that cross-check is the closest available substitute. It is
 * NOT a byte-identical copy of the .rsc file: the one-shot
 * registration step runs inline via /rest/execute here instead of
 * being installed as a separate persisted script object (deliberate —
 * a script that only ever runs once doesn't need to persist as a
 * named router object), and log message wording is paraphrased rather
 * than copied verbatim. Neither difference changes what the router
 * actually does. That source file's own header says it was written
 * against documented RouterOS 7 syntax, not validated against
 * physical hardware — this generator inherits that same status. Test
 * against a spare device or a Cloud Hosted Router before relying on
 * this in the field.
 */
final class RouterOsScripts {

    private RouterOsScripts() {}

    private static final Pattern PAIRING_CODE_RE = Pattern.compile("^[A-Z0-9]{4,10}$");

    static final class InvalidPairingCodeException extends IllegalArgumentException {
        InvalidPairingCodeException(String code) {
            super("Pairing code has an unexpected format: " + code);
        }
    }

    /**
     * Step 1 (run once, idempotent): installs the recurring checkin
     * script + a disabled scheduler entry. Safe to re-run.
     *
     * Assumes frontend and backend share an origin (true by default
     * in this project's own docker-compose.yml/nginx.conf). If that
     * ever changes, apiBaseUrl needs to come from its own config
     * field instead of reusing the app's server URL.
     */
    static String buildInstallCheckinScript(String apiBaseUrl) {
        String api = trimTrailingSlash(apiBaseUrl);
        return "" +
            ":global resLinkApiUrl \"" + api + "\"\n" +
            ":global resLinkCredFile \"reslink-credentials.txt\"\n" +
            "\n" +
            "/system script\n" +
            ":if ([:len [/system script find name=\"reslink-checkin\"]] > 0) do={ remove [find name=\"reslink-checkin\"] }\n" +
            "add name=\"reslink-checkin\" source={\n" +
            "  :global resLinkApiUrl\n" +
            "  :global resLinkCredFile\n" +
            "\n" +
            "  :if ([:len [/file find name=$resLinkCredFile]] = 0) do={\n" +
            "    :log warning \"reslink-checkin: not paired yet\"\n" +
            "    :error \"reslink-checkin: no credentials file\"\n" +
            "  }\n" +
            "\n" +
            "  :local credContents [/file get [find name=$resLinkCredFile] contents]\n" +
            "  :local nl1 [:find $credContents \"\\n\"]\n" +
            "  :local routerId [:pick $credContents 0 $nl1]\n" +
            "  :local rest [:pick $credContents ($nl1 + 1) [:len $credContents]]\n" +
            "  :local nl2 [:find $rest \"\\n\"]\n" +
            "  :local apiKey [:pick $rest 0 $nl2]\n" +
            "\n" +
            "  :local postData (\"router_id=\" . $routerId . \"&api_key=\" . $apiKey)\n" +
            "  :local result \"\"\n" +
            "  :do {\n" +
            "    :local fetchResult [/tool fetch url=($resLinkApiUrl . \"/api/agent/checkin\") http-method=post http-data=$postData as-value output=user]\n" +
            "    :set result ($fetchResult->\"data\")\n" +
            "  } on-error={\n" +
            "    :log warning \"reslink-checkin: could not reach Reslink this cycle\"\n" +
            "    :error \"reslink-checkin: fetch failed\"\n" +
            "  }\n" +
            "\n" +
            "  :if ([:find $result \"STATUS OK\"] = nil) do={\n" +
            "    :log warning (\"reslink-checkin: server rejected check-in - \" . $result)\n" +
            "    :error \"reslink-checkin: bad response\"\n" +
            "  }\n" +
            "\n" +
            "  :local pos 0\n" +
            "  :while ($pos < [:len $result]) do={\n" +
            "    :local nl [:find $result \"\\n\" $pos]\n" +
            "    :if ($nl = nil) do={ :set nl [:len $result] }\n" +
            "    :local line [:pick $result $pos $nl]\n" +
            "    :set pos ($nl + 1)\n" +
            "    :if ([:pick $line 0 4] = \"CMD \") do={\n" +
            "      :local rest2 [:pick $line 4 [:len $line]]\n" +
            "      :local fields {}\n" +
            "      :local fpos 0\n" +
            "      :while ($fpos <= [:len $rest2]) do={\n" +
            "        :local sp [:find $rest2 \" \" $fpos]\n" +
            "        :if ($sp = nil) do={ :set sp [:len $rest2] }\n" +
            "        :set fields ($fields, [:pick $rest2 $fpos $sp])\n" +
            "        :set fpos ($sp + 1)\n" +
            "      }\n" +
            "      :local cmdId ($fields->0)\n" +
            "      :local cmdType ($fields->1)\n" +
            "      :local cmdUser ($fields->2)\n" +
            "      :local cmdPass ($fields->3)\n" +
            "      :local cmdBandwidth ($fields->5)\n" +
            "\n" +
            "      :local execStatus \"executed\"\n" +
            "      :local execDetail \"\"\n" +
            "      :do {\n" +
            "        :if ($cmdType = \"create_user\") do={\n" +
            "          :local rateLimit ($cmdBandwidth . \"M/\" . $cmdBandwidth . \"M\")\n" +
            "          :if ([:len [/ip hotspot user find name=$cmdUser]] > 0) do={\n" +
            "            /ip hotspot user set [find name=$cmdUser] password=$cmdPass rate-limit=$rateLimit\n" +
            "          } else={\n" +
            "            /ip hotspot user add name=$cmdUser password=$cmdPass rate-limit=$rateLimit\n" +
            "          }\n" +
            "        } else={ :if ($cmdType = \"enable_user\") do={\n" +
            "          /ip hotspot user enable [find name=$cmdUser]\n" +
            "        } else={ :if ($cmdType = \"disable_user\") do={\n" +
            "          /ip hotspot user disable [find name=$cmdUser]\n" +
            "        } else={ :if ($cmdType = \"delete_user\") do={\n" +
            "          /ip hotspot user remove [find name=$cmdUser]\n" +
            "        } else={\n" +
            "          :set execStatus \"failed\"\n" +
            "          :set execDetail (\"unknown command type: \" . $cmdType)\n" +
            "        }}}}\n" +
            "      } on-error={\n" +
            "        :set execStatus \"failed\"\n" +
            "        :set execDetail (\"RouterOS command threw an error executing \" . $cmdType)\n" +
            "      }\n" +
            "\n" +
            "      :local ackData (\"router_id=\" . $routerId . \"&api_key=\" . $apiKey . \"&status=\" . $execStatus . \"&detail=\" . $execDetail)\n" +
            "      :do {\n" +
            "        /tool fetch url=($resLinkApiUrl . \"/api/agent/commands/\" . $cmdId . \"/ack\") http-method=post http-data=$ackData output=none\n" +
            "      } on-error={\n" +
            "        :log warning (\"reslink-checkin: could not ack command \" . $cmdId)\n" +
            "      }\n" +
            "    }\n" +
            "  }\n" +
            "}\n" +
            "\n" +
            "/system scheduler\n" +
            ":if ([:len [/system scheduler find name=\"reslink-checkin\"]] > 0) do={ remove [find name=\"reslink-checkin\"] }\n" +
            "add name=\"reslink-checkin\" interval=30s on-event=\"/system script run reslink-checkin\" disabled=yes\n" +
            ":put \"checkin script installed\"\n";
    }

    /**
     * Step 2 (run once): the equivalent of a human running
     * `/system script run reslink-register` after pasting in the
     * pairing code by hand, except the code is baked in by the app
     * and this runs inline via /rest/execute rather than being saved
     * as a named script.
     */
    static String buildRegisterScript(String pairingCode, String apiBaseUrl) {
        if (!PAIRING_CODE_RE.matcher(pairingCode).matches()) {
            throw new InvalidPairingCodeException(pairingCode);
        }
        String api = trimTrailingSlash(apiBaseUrl);
        return "" +
            ":global resLinkApiUrl \"" + api + "\"\n" +
            ":global resLinkCredFile \"reslink-credentials.txt\"\n" +
            ":local pairingCode \"" + pairingCode + "\"\n" +
            "\n" +
            ":local routerIdentity [/system identity get name]\n" +
            ":local routerModel [/system routerboard get model]\n" +
            ":local routerFirmware (\"RouterOS \" . [/system package get [find name=\"routeros\"] version])\n" +
            "\n" +
            ":local postData (\"code=\" . $pairingCode . \"&model=\" . $routerModel . \"&firmware=\" . $routerFirmware . \"&identity=\" . $routerIdentity)\n" +
            "\n" +
            ":local result \"\"\n" +
            ":do {\n" +
            "  :local fetchResult [/tool fetch url=($resLinkApiUrl . \"/api/agent/register\") http-method=post http-data=$postData as-value output=user]\n" +
            "  :set result ($fetchResult->\"data\")\n" +
            "} on-error={\n" +
            "  :log error \"reslink-register: could not reach Reslink\"\n" +
            "  :error \"reslink-register: fetch failed\"\n" +
            "}\n" +
            "\n" +
            ":if ([:find $result \"STATUS OK\"] = nil) do={\n" +
            "  :log error (\"reslink-register: registration failed - \" . $result)\n" +
            "  :error \"reslink-register: server rejected registration\"\n" +
            "}\n" +
            "\n" +
            ":local routerId \"\"\n" +
            ":local apiKey \"\"\n" +
            ":local pos 0\n" +
            ":while ($pos < [:len $result]) do={\n" +
            "  :local nl [:find $result \"\\n\" $pos]\n" +
            "  :if ($nl = nil) do={ :set nl [:len $result] }\n" +
            "  :local line [:pick $result $pos $nl]\n" +
            "  :if ([:pick $line 0 10] = \"ROUTER_ID \") do={ :set routerId [:pick $line 10 [:len $line]] }\n" +
            "  :if ([:pick $line 0 8] = \"API_KEY \") do={ :set apiKey [:pick $line 8 [:len $line]] }\n" +
            "  :set pos ($nl + 1)\n" +
            "}\n" +
            "\n" +
            ":if ($routerId = \"\" or $apiKey = \"\") do={\n" +
            "  :log error \"reslink-register: could not parse ROUTER_ID/API_KEY\"\n" +
            "  :error \"reslink-register: parse failure\"\n" +
            "}\n" +
            "\n" +
            ":local credContents ($routerId . \"\\n\" . $apiKey . \"\\n\")\n" +
            ":if ([:len [/file find name=$resLinkCredFile]] > 0) do={ /file remove [find name=$resLinkCredFile] }\n" +
            "/file add name=$resLinkCredFile contents=$credContents\n" +
            "\n" +
            "/system scheduler enable [find name=\"reslink-checkin\"]\n" +
            ":put (\"ROUTER_ID=\" . $routerId)\n";
    }

    private static String trimTrailingSlash(String s) {
        int end = s.length();
        while (end > 0 && s.charAt(end - 1) == '/') end--;
        return s.substring(0, end);
    }
}
