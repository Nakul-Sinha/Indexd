provider "kubernetes" {
  # Reuses the existing farlands-dev EKS cluster in this AWS account.
  # Do not recreate the VPC/EKS control plane from this stack.
  config_path = var.kubeconfig_path
}
