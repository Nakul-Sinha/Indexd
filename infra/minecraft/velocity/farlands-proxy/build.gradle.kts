plugins {
    java
    // Shadow bundles Gson into the plugin jar so it is always available,
    // regardless of what Velocity ships internally.
    id("com.gradleup.shadow") version "8.3.6"
}

group = "com.farlands.proxy"
version = "1.0.0"
description = "Farlands dynamic server routing plugin for Velocity"

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}

repositories {
    mavenCentral()
    // PaperMC repository hosts the official Velocity API artifacts.
    maven("https://repo.papermc.io/repository/maven-public/")
}

dependencies {
    // Velocity API – compileOnly because Velocity provides it at runtime.
    compileOnly("com.velocitypowered:velocity-api:3.4.0-SNAPSHOT")
    // Annotation processor generates the @Plugin metadata JSON at compile time.
    annotationProcessor("com.velocitypowered:velocity-api:3.4.0-SNAPSHOT")
    // Gson is used for JSON parsing; we bundle it via shadow so we own the version.
    implementation("com.google.code.gson:gson:2.11.0")
}

tasks {
    // Point Gradle at the shadow jar so `gradle build` produces a fat jar.
    build {
        dependsOn(shadowJar)
    }

    shadowJar {
        // Relocate Gson so it does not clash with any Gson bundled by other plugins.
        relocate("com.google.gson", "com.farlands.proxy.libs.gson")
        archiveClassifier.set("")
    }

    compileJava {
        options.encoding = "UTF-8"
        // Velocity's annotation processor requires source/target 21 to work correctly.
        options.release = 21
    }
}
