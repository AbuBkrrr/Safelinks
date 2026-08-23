package com.aibrainsventures.safelinks;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.RouteInfo;

import java.net.Inet4Address;
import java.net.InetAddress;

/**
 * Java port of GatewayLocator.kt. Uses ConnectivityManager/
 * LinkProperties rather than WifiManager.getConnectionInfo() -
 * reading the gateway/route table doesn't require
 * ACCESS_FINE_LOCATION, whereas reading the SSID/BSSID does. This
 * feature never needs the SSID, so it never triggers that permission.
 */
final class GatewayLocator {

    private GatewayLocator() {}

    static final class Result {
        final String gatewayIp;
        final boolean isWifi;

        Result(String gatewayIp, boolean isWifi) {
            this.gatewayIp = gatewayIp;
            this.isWifi = isWifi;
        }
    }

    static Result locate(Context context) {
        ConnectivityManager cm = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return null;

        Network network = cm.getActiveNetwork();
        if (network == null) return null;

        NetworkCapabilities caps = cm.getNetworkCapabilities(network);
        if (caps == null) return null;
        boolean isWifi = caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI);

        LinkProperties linkProperties = cm.getLinkProperties(network);
        if (linkProperties == null) return null;

        for (RouteInfo route : linkProperties.getRoutes()) {
            if (!route.isDefaultRoute()) continue;
            InetAddress gateway = route.getGateway();
            if (gateway instanceof Inet4Address) {
                return new Result(gateway.getHostAddress(), isWifi);
            }
        }
        return null;
    }
}
