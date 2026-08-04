# dstack cloud (Intel TDX): placeholder module for any provider that runs dstack CVMs from a compose file.
#
# It creates nothing. a dstack cloud deploys an app from a docker-compose file through its CLI or dashboard, and this
# repository does not assume a Terraform provider for it. The module renders what you hand to the cloud: the compose file
# the sidecar's dstack example uses, with your values, and the CLI commands to deploy and check it.
#
# Provider notes:
# - dstack measures the compose file into the quote; the sidecar reads its own evidence through the guest agent socket
#   (attestation.provider: dstack). Keep every image pinned by digest.
# - GPU nodes run vLLM in the CVM; CPU nodes run llama.cpp. Weights are downloaded inside the VM and checked by digest
#   (see sidecar/examples/dstack/README.md and `bun sidecar/src/cli.ts init --target dstack-gpu`).
# - The commands follow sidecar/examples/dstack/README.md. Replace <dstack cloud CLI> with your provider's CLI and check its flags before running.

terraform {
  required_version = ">= 1.5"
}

locals {
  compose_file = abspath(var.compose_file)
  commands = [
    "bun sidecar/src/cli.ts init --target ${var.gpu ? "dstack-gpu" : "dstack-cpu"} --out ${var.out_dir}   # writes the pinned compose file and sidecar.yaml",
    "<dstack cloud CLI> deploy -n ${var.name} -c ${local.compose_file}${var.node_type != "" ? " -t ${var.node_type}" : ""} --wait",
    "<dstack cloud CLI> cvms attestation ${var.name} --json   # the compose hash dstack measured",
    "bun scripts/graft-cli.ts verify https://<the app's 8443 endpoint>",
  ]
}
