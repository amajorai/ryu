package com.ryu.example

import com.ryu.sdk.ModelClient
import com.ryu.sdk.assertAllowedEgress
import com.ryu.sdk.resolveGatewayUrl
import com.ryu.sdk.validatePluginId

fun main() {
    validatePluginId("com.example.kotlin")
    check(runCatching { assertAllowedEgress("https://api.openai.com") }.isFailure) {
        "direct provider egress was unexpectedly allowed"
    }
    ModelClient("gemma4", "http://127.0.0.1:7981", null).use { }
    println("Ryu Kotlin SDK example ready: ${resolveGatewayUrl()}")
}
