FROM eclipse-temurin:21-jre-jammy

WORKDIR /server

COPY paper-26.1.2-69.jar server.jar
COPY server.properties server.properties

RUN echo "eula=true" > eula.txt

EXPOSE 25567

CMD ["java", "-Xms512M", "-Xmx1G", "-jar", "server.jar", "--nogui"]
