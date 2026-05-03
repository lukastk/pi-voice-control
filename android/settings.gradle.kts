pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // io.livekit:livekit-android transitively pulls
        // com.github.davidliu:audioswitch, which is only published on
        // JitPack. Scoped to com.github.* so this can't shadow Maven
        // Central / Google for unrelated artifacts.
        maven {
            url = uri("https://jitpack.io")
            content { includeGroupByRegex("com\\.github\\..*") }
        }
    }
}

rootProject.name = "voice-agent-bridge"
include(":app")
