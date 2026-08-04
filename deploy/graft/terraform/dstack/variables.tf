variable "name" {
  description = "App name on the dstack cloud."
  type        = string
  default     = "trellis-graft"
}

variable "gpu" {
  description = "A GPU node (vLLM) rather than a CPU node (llama.cpp)."
  type        = bool
  default     = true
}

variable "node_type" {
  description = "Instance type, as the cloud CLI names it (e.g. tdx.medium for CPU). Empty leaves the CLI's default."
  type        = string
  default     = ""
}

variable "out_dir" {
  description = "Where the sidecar's onboarding CLI writes the dstack files."
  type        = string
  default     = "trellis-provider"
}

variable "compose_file" {
  description = "The compose file to deploy (written by the onboarding CLI)."
  type        = string
  default     = "trellis-provider/docker-compose.yml"
}
