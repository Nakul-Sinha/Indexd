import AdmZip from "adm-zip";
import { getRuntimeJar } from "./runtime-jar";

export async function buildPluginJar(pluginName: string, yamlContent: string): Promise<Buffer> {
  const runtimeJar = await getRuntimeJar();

  const zip = new AdmZip(runtimeJar);

  zip.deleteFile("config.yml");

  zip.addFile("config.yml", Buffer.from(yamlContent, "utf8"));

  const pluginYml = [
    `name: ${pluginName}`,
    "version: 1.0.0",
    "main: com.farlands.PluginMain",
    "api-version: 1.20",
  ].join("\n");

  zip.deleteFile("plugin.yml");

  zip.addFile("plugin.yml", Buffer.from(pluginYml.trim(), "utf8"));

  return zip.toBuffer();
}
