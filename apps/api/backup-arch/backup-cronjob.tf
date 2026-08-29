resource "kubernetes_cron_job_v1" "server_backup_orchestrator" {
  metadata {
    name      = "server-backup-orchestrator"
    namespace = "infra-team"
  }

  spec {
    schedule                      = "0 */6 * * *"
    concurrency_policy            = "Forbid"
    successful_jobs_history_limit = 3
    failed_jobs_history_limit     = 3

    job_template {
      metadata {
        labels = {
          app = "server-backup-orchestrator"
        }
      }

      spec {
        template {
          metadata {
            labels = {
              app = "server-backup-orchestrator"
            }
          }

          spec {
            service_account_name = "backup-orchestrator"
            restart_policy        = "OnFailure"

            container {
              name  = "orchestrator"
              image = var.backup_orchestrator_image

              env {
                name  = "NAMESPACE"
                value = "infra-team"
              }

              env {
                name  = "PVC_LABEL_SELECTOR"
                value = "app.kubernetes.io/name=farlands-game-server"
              }

              env {
                name  = "S3_BUCKET"
                value = var.backup_s3_bucket
              }

              env {
                name  = "S3_REGION"
                value = var.aws_region
              }

              env {
                name  = "S3_PREFIX"
                value = "infra-team"
              }

              env {
                name  = "BACKUP_IMAGE_ARCHIVE"
                value = "alpine:3.20"
              }

              env {
                name  = "BACKUP_IMAGE_UPLOAD"
                value = "amazon/aws-cli:2.15.0"
              }

              env {
                name  = "BACKUP_SERVICE_ACCOUNT"
                value = "backup-orchestrator"
              }
            }
          }
        }
      }
    }
  }
}