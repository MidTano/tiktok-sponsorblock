plugins {
    `java-library`
}

group = "io.github.midtano"
version = "0.1.0"

repositories {
    mavenCentral()
}

java {
    // Android extensions and Morphe patches compile against Java 11.
    toolchain.languageVersion.set(JavaLanguageVersion.of(21))
}

tasks.withType<JavaCompile>().configureEach {
    options.release.set(11)
    options.encoding = "UTF-8"
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}

tasks.test {
    testLogging {
        events("failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
