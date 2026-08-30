plugins {
    application
    kotlin("jvm") version "2.1.21"
}

group = "com.ryu"
version = "0.2.2"

repositories {
    mavenCentral()
}

dependencies {
    implementation("net.java.dev.jna:jna:5.17.0")
    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.12.2")
}

kotlin {
    jvmToolchain(17)
}

application {
    mainClass = "com.ryu.example.MainKt"
}

val ryuLibrary = providers.gradleProperty("ryuLibrary")
    .orElse(providers.environmentVariable("RYU_UNIFFI_LIBRARY"))

tasks.withType<Test>().configureEach {
    useJUnitPlatform()
    ryuLibrary.orNull?.let { systemProperty("uniffi.component.ryu_sdk.libraryOverride", it) }
}

tasks.named<JavaExec>("run") {
    ryuLibrary.orNull?.let { systemProperty("uniffi.component.ryu_sdk.libraryOverride", it) }
}
