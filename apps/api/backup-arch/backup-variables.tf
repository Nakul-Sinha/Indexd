variable "backup_orchestrator_image" {
  description = "Container image for the backup orchestrator (lists PVCs, spawns backup Jobs)"
  type        = string
  default     = "963957629631.dkr.ecr.ap-south-1.amazonaws.com/farlands-backup-orchestrator:latest"
}

variable "backup_s3_bucket" {
  description = "S3 bucket where server backups are stored"
  type        = string
  default     = "farlands-eks-backups-963957629631-ap-south-1"
}

variable "aws_region" {
  description = "AWS region for S3 and EKS"
  type        = string
  default     = "ap-south-1"
}