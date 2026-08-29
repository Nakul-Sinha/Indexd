variable "namespace" {
  type        = string
  description = "Kubernetes namespace to deploy into."
  default     = "infra-team"
}
variable "kubeconfig_path" {
  description = "Path to the kubeconfig file"
  type        = string
  default     = "~/.kube/config"
}
