#!/bin/bash
# =====================================================================
#  ShopEase - one-time EC2 server setup (Ubuntu 24.04 LTS)
#
#  Installs: Docker, Jenkins (Java 21), k3s Kubernetes, AWS CLI v2,
#            CloudWatch agent, 2 GB swap
#
#  Usage (on the EC2 instance):
#     sudo bash setup-ec2.sh <s3-bucket-name> [aws-region]
#  Example:
#     sudo bash setup-ec2.sh shopease-artifacts-vikram ap-south-1
# =====================================================================
set -euo pipefail

S3_BUCKET="${1:-}"
AWS_REGION="${2:-ap-south-1}"

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo"; exit 1; fi
if [ -z "$S3_BUCKET" ]; then
  echo "Usage: sudo bash setup-ec2.sh <s3-bucket-name> [aws-region]"; exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export DEBIAN_FRONTEND=noninteractive
step() { echo -e "\n\033[1;34m==> $*\033[0m"; }

step "1/8  System packages"
apt-get update -y
apt-get install -y ca-certificates curl wget gnupg unzip git jq fontconfig openjdk-21-jre-headless

step "2/8  Swap (2 GB) - keeps Jenkins + Kubernetes stable on 4 GB RAM"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

step "3/8  Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker
usermod -aG docker ubuntu || true

step "4/8  Jenkins"
if ! command -v jenkins >/dev/null && [ ! -f /usr/share/java/jenkins.war ]; then
  mkdir -p /etc/apt/keyrings
  wget -qO /etc/apt/keyrings/jenkins-keyring.asc https://pkg.jenkins.io/debian-stable/jenkins.io-2026.key
  echo "deb [signed-by=/etc/apt/keyrings/jenkins-keyring.asc] https://pkg.jenkins.io/debian-stable binary/" \
    > /etc/apt/sources.list.d/jenkins.list
  apt-get update -y
  apt-get install -y jenkins
fi
usermod -aG docker jenkins
systemctl enable jenkins

# Jenkins logs to journald; mirror them to a file so the CloudWatch agent can ship them
mkdir -p /var/log/jenkins
cat > /etc/systemd/system/jenkins-log-export.service <<'UNIT'
[Unit]
Description=Mirror Jenkins journald logs to /var/log/jenkins/jenkins.log for CloudWatch
After=jenkins.service

[Service]
ExecStart=/bin/sh -c 'exec journalctl -u jenkins -f -o short-iso >> /var/log/jenkins/jenkins.log'
Restart=always

[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/logrotate.d/jenkins-export <<'ROT'
/var/log/jenkins/jenkins.log {
  weekly
  rotate 4
  compress
  copytruncate
  missingok
}
ROT
systemctl daemon-reload
systemctl enable --now jenkins-log-export

step "5/8  k3s (lightweight Kubernetes)"
if ! command -v k3s >/dev/null; then
  curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--write-kubeconfig-mode 644" sh -
fi
# wait for the node to be Ready
for i in $(seq 1 60); do
  k3s kubectl get nodes 2>/dev/null | grep -q " Ready" && break
  sleep 3
done
k3s kubectl get nodes

# give Jenkins a kubeconfig + permission to import images into k3s
mkdir -p /var/lib/jenkins/.kube
cp /etc/rancher/k3s/k3s.yaml /var/lib/jenkins/.kube/config
chown -R jenkins:jenkins /var/lib/jenkins/.kube
chmod 600 /var/lib/jenkins/.kube/config
echo 'jenkins ALL=(root) NOPASSWD: /usr/local/bin/k3s' > /etc/sudoers.d/jenkins-k3s
chmod 440 /etc/sudoers.d/jenkins-k3s
visudo -cf /etc/sudoers.d/jenkins-k3s

step "6/8  AWS CLI v2"
if ! command -v aws >/dev/null; then
  TMP=$(mktemp -d)
  ARCH=$(uname -m)   # x86_64 or aarch64
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${ARCH}.zip" -o "$TMP/awscli.zip"
  unzip -q "$TMP/awscli.zip" -d "$TMP"
  "$TMP/aws/install"
  rm -rf "$TMP"
fi

step "7/8  CloudWatch agent (metrics + app/Jenkins logs)"
if [ ! -x /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl ]; then
  DEB_ARCH=$(dpkg --print-architecture)   # amd64 or arm64
  wget -qO /tmp/amazon-cloudwatch-agent.deb \
    "https://amazoncloudwatch-agent.s3.amazonaws.com/ubuntu/${DEB_ARCH}/latest/amazon-cloudwatch-agent.deb"
  dpkg -i /tmp/amazon-cloudwatch-agent.deb
  rm -f /tmp/amazon-cloudwatch-agent.deb
fi
cp "$SCRIPT_DIR/../cloudwatch/amazon-cloudwatch-agent.json" /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json

step "8/8  Pipeline settings for Jenkins"
mkdir -p /etc/shopease
cat > /etc/shopease/pipeline.env <<EOF
S3_BUCKET=${S3_BUCKET}
AWS_REGION=${AWS_REGION}
EOF
chmod 644 /etc/shopease/pipeline.env

systemctl restart jenkins
sleep 10

# Quick checks
echo
echo "Checking AWS access via the EC2 IAM role..."
if aws s3 ls "s3://${S3_BUCKET}" --region "$AWS_REGION" >/dev/null 2>&1; then
  echo "  S3 bucket ${S3_BUCKET}: OK"
else
  echo "  WARNING: cannot reach s3://${S3_BUCKET}. Check the bucket name and the IAM role attached to this EC2."
fi

PUBLIC_IP=$(curl -s --max-time 3 -H "X-aws-ec2-metadata-token: $(curl -s -X PUT --max-time 3 http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')" \
  http://169.254.169.254/latest/meta-data/public-ipv4 || echo "<ELASTIC-IP>")

echo
echo "====================================================================="
echo " Setup complete!"
echo "   Jenkins : http://${PUBLIC_IP}:8080"
echo "   Website : http://${PUBLIC_IP}/   (live after the first pipeline run)"
echo
echo " Jenkins initial admin password:"
cat /var/lib/jenkins/secrets/initialAdminPassword 2>/dev/null || echo "   (not found - Jenkins may still be starting; run: sudo cat /var/lib/jenkins/secrets/initialAdminPassword)"
echo "====================================================================="
