// bun examples/generate.ts  (needs TRELLIS_API_KEY)
import { embed, generateText, streamText } from "ai";
import { trellis, createTrellis } from "../src/index.ts";

const { text, providerMetadata } = await generateText({
  model: trellis("meta-llama/llama-3.3-70b-instruct"),
  prompt: "Say hello in five words.",
});
console.log(text, providerMetadata?.trellis); // { receiptId, receiptKeyId, costUsd }

// Attested lane: only providers with a verified enclave, or a refusal with nothing sent.
const attested = createTrellis({ lane: "attested" });
const stream = streamText({ model: attested("z-ai/glm-5.3"), prompt: "One fact about enclaves." });
for await (const part of stream.textStream) process.stdout.write(part);
console.log("\n", await stream.providerMetadata);

const { embedding } = await embed({ model: trellis.embeddingModel("qwen/qwen3-embedding-8b"), value: "hello" });
console.log(embedding.length);
