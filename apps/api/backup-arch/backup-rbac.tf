resource "kubernetes_service_account_v1" "backup_orchestrator" {
  metadata {
    name      = "backup-orchestrator"
    namespace = "infra-team"
  }
}

resource "kubernetes_role_v1" "backup_orchestrator" {
  metadata {
    name      = "backup-orchestrator"
    namespace = "infra-team"
  }

  rule {
    api_groups = [""]
    resources  = ["persistentvolumeclaims"]
    verbs      = ["get", "list", "watch"]
  }

  rule {
    api_groups = ["batch"]
    resources  = ["jobs"]
    verbs      = ["create", "get", "list", "watch", "delete"]
  }

  rule {
    api_groups = [""]
    resources  = ["pods"]
    verbs      = ["get", "list", "watch", "delete"]
  }
}

resource "kubernetes_role_binding_v1" "backup_orchestrator" {
  metadata {
    name      = "backup-orchestrator"
    namespace = "infra-team"
  }

  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "Role"
    name      = kubernetes_role_v1.backup_orchestrator.metadata[0].name
  }

  subject {
    kind      = "ServiceAccount"
    name      = kubernetes_service_account_v1.backup_orchestrator.metadata[0].name
    namespace = kubernetes_service_account_v1.backup_orchestrator.metadata[0].namespace
  }
}