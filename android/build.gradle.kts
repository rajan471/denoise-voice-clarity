plugins {
    id("com.android.library") version "8.5.2"
    id("org.jetbrains.kotlin.android") version "2.0.20"
    id("maven-publish")
}

android {
    namespace = "com.gruner.voiceclarity"
    compileSdk = 35
    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    // AGP 8.x does not create a publishable component unless asked.
    publishing {
        singleVariant("release")
    }
}

kotlin { jvmToolchain(17) }

dependencies {
    // The app supplies its own LiveKit SDK; we only compile against it.
    compileOnly("io.livekit:livekit-android:2.18.2")
    testImplementation("io.livekit:livekit-android:2.18.2")
    testImplementation("junit:junit:4.13.2")
}

// Publishing to the GitLab package registry: the mobile team's pipeline sets
// GITLAB_MAVEN_URL + CI_JOB_TOKEN; locally the AAR is consumed as a file dep.
publishing {
    publications {
        register<MavenPublication>("release") {
            groupId = "com.gruner"
            artifactId = "voiceclarity"
            version = "0.1.0"
            afterEvaluate { from(components["release"]) }
        }
    }
    repositories {
        maven {
            url = uri(
                System.getenv("GITLAB_MAVEN_URL")
                    ?: layout.buildDirectory.dir("repo").get().toString(),
            )
            credentials(HttpHeaderCredentials::class) {
                name = "Job-Token"
                value = System.getenv("CI_JOB_TOKEN") ?: ""
            }
            authentication { create<HttpHeaderAuthentication>("header") }
        }
    }
}
