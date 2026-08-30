package com.ryu.example

import com.ryu.sdk.ModelClient
import com.ryu.sdk.RyuException
import com.ryu.sdk.assertAllowedEgress
import com.ryu.sdk.parseAndValidateManifest
import com.ryu.sdk.pluginManifestJsonSchema
import com.ryu.sdk.validatePluginId
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull

class RyuSdkTest {
    @Test
    fun validationAndEgressUseTheRustKernel() {
        validatePluginId("io.ryu.kotlin")
        assertFailsWith<RyuException> { validatePluginId("../evil") }
        assertAllowedEgress("http://127.0.0.1:7981")
        assertFailsWith<RyuException> { assertAllowedEgress("https://api.openai.com") }
    }

    @Test
    fun manifestAndClientSurface() {
        val manifest = """
            {"id":"com.example.kotlin","name":"Kotlin","version":"1.0.0","runnables":[]}
        """.trimIndent()
        assertContains(parseAndValidateManifest(manifest), "com.example.kotlin")
        assertContains(pluginManifestJsonSchema(), "properties")

        val client = ModelClient("gemma4", "http://127.0.0.1:7981", null)
        assertNotNull(client)
        client.close()
        assertFailsWith<RyuException> {
            ModelClient("gpt-4o", "https://api.openai.com", null)
        }
    }
}
