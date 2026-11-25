resource "random_id" "this" {
  byte_length = 4

  keepers = {
    seed_input = try(var.aws_app_code, terraform.workspace)
  }
}

# Signing key for the tracker API's JWTs, exposed to Lambda as JWT_SECRET
resource "random_password" "jwt" {
  length  = 48
  special = false
}

# Demo users' password in AWS when var.demo_password is not set (letters and digits)
resource "random_password" "demo" {
  length  = 20
  special = false
}

resource "random_pet" "this" {
  length    = 3
  separator = "-"

  keepers = {
    seed_input = try(var.aws_app_code, terraform.workspace)
  }
}
