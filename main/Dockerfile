# Use a standard Java environment
FROM eclipse-temurin:17-jdk

# Set the working directory
WORKDIR /app

# Copy all your files into the cloud container
COPY . .

# Make your script executable and run it
RUN chmod +x run.sh
CMD ["bash", "run.sh"]