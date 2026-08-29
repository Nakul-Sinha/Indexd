# ── Stage 1: compile the farlands-proxy Gradle plugin ────────────────────────
FROM eclipse-temurin:21-jdk-jammy AS builder

WORKDIR /build

# Copy only the Gradle wrapper and build files first so Docker can cache the
# dependency-download layer independently of source code changes.
COPY farlands-proxy/gradlew farlands-proxy/gradlew
COPY farlands-proxy/gradle  farlands-proxy/gradle
COPY farlands-proxy/settings.gradle.kts farlands-proxy/
COPY farlands-proxy/build.gradle.kts    farlands-proxy/

WORKDIR /build/farlands-proxy
# Download all dependencies (cache layer).
RUN ./gradlew dependencies --no-daemon --quiet 2>/dev/null || true

# Now copy the full source and build the fat (shadow) jar.
COPY farlands-proxy/src ./src
RUN ./gradlew shadowJar --no-daemon --stacktrace

# ── Stage 2: assemble the final Velocity image ────────────────────────────────
FROM eclipse-temurin:21-jre-jammy

WORKDIR /velocity

# Velocity server jar + config.
COPY velocity-3.5.0-SNAPSHOT-601.jar velocity.jar
COPY velocity.toml velocity.toml

# Copy the compiled plugin fat-jar into the plugins directory.
COPY --from=builder /build/farlands-proxy/build/libs/farlands-proxy-1.0.0.jar plugins/farlands-proxy.jar

EXPOSE 25565

# Pass API credentials via environment variables
CMD ["java", "-Xms512M", "-Xmx512M", "-jar", "velocity.jar"]
