'use client';
import { useState } from 'react';
import styles from '../Landing.module.css';

const MODEL = 'meta-llama/llama-3.3-70b-instruct';
const CLIENTS = {
  Node: `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: \`\${process.env.TRELLIS_URL}/api/v1\`,
  apiKey: process.env.TRELLIS_KEY,
});

const reply = await client.chat.completions.create({
  model: "${MODEL}",
  messages: [{ role: "user", content: "Hello" }],
});`,
  Python: `import os
from openai import OpenAI

client = OpenAI(
    base_url=f"{os.environ['TRELLIS_URL']}/api/v1",
    api_key=os.environ["TRELLIS_KEY"],
)

reply = client.chat.completions.create(
    model="${MODEL}",
    messages=[{"role": "user", "content": "Hello"}],
)`,
  curl: `curl "$TRELLIS_URL/api/v1/chat/completions" \\
  -H "Authorization: Bearer $TRELLIS_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${MODEL}",
    "messages": [{"role": "user", "content": "Hello"}]
  }'`,
};
const BACK = [
  ['x-receipt-id', 'The signed receipt for this call. Look it up on /verify/ or through the API.'],
  ['x-generation-id', 'The generation record: model, provider, exact tokens and cost.'],
  ['x-trellis-lane', 'The lane that served the call.'],
];

/** The same request in three clients, and the headers that come back beside the answer. */
export function FirstCall() {
  const [client, setClient] = useState('Node');
  return <div className={styles.console}>
    <div className={styles.consoleBar}>
      <div className={styles.segmented} role="group" aria-label="Client">
        {Object.keys(CLIENTS).map(name => <button key={name} type="button" aria-pressed={client === name} onClick={() => setClient(name)}>{name}</button>)}
      </div>
      <span>POST /api/v1/chat/completions</span>
    </div>
    <div className={styles.consoleBody}>
      <pre className={styles.code} aria-label={`${client} example`}><code>{CLIENTS[client]}</code></pre>
      <div className={styles.consoleSide}>
        <h3>Returned with the answer</h3>
        <dl>{BACK.map(([name, text]) => <div key={name}><dt>{name}</dt><dd>{text}</dd></div>)}</dl>
      </div>
    </div>
  </div>;
}
