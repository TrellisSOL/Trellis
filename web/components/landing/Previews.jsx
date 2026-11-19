'use client';
import { useState } from 'react';
import styles from '../Landing.module.css';

const endpoint = 'https://trellischat.app/api/v1/models';
const CLIENTS = {
  curl: `curl -sS ${endpoint}`,
  Node: `const response = await fetch("${endpoint}");
const { data } = await response.json();
console.log(data.map(model => model.id));`,
  Python: `import json
from urllib.request import urlopen

with urlopen("${endpoint}") as response:
    models = json.load(response)["data"]
    print([model["id"] for model in models])`,
};
const FIELDS = [
  ['id', 'Use this identifier when requesting a quote.'],
  ['context_length', 'Maximum context size, in tokens.'],
  ['pricing', 'Input and output rates for this model.'],
];

export function FirstCall() {
  const [client, setClient] = useState('curl');
  return <div className={styles.console}>
    <div className={styles.consoleBar}>
      <div className={styles.segmented} role="group" aria-label="Client">
        {Object.keys(CLIENTS).map(name => <button key={name} type="button" aria-pressed={client === name} onClick={() => setClient(name)}>{name}</button>)}
      </div>
      <span>GET /api/v1/models</span>
    </div>
    <div className={styles.consoleBody}>
      <pre className={styles.code} aria-label={`${client} example`}><code>{CLIENTS[client]}</code></pre>
      <div className={styles.consoleSide}>
        <h3>In each model record</h3>
        <dl>{FIELDS.map(([name, text]) => <div key={name}><dt>{name}</dt><dd>{text}</dd></div>)}</dl>
      </div>
    </div>
  </div>;
}
