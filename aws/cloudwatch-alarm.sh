#!/bin/bash
# Optional: create CloudWatch alarms + email alerts. Run from the EC2 instance (or anywhere with AWS CLI).
#   bash aws/cloudwatch-alarm.sh <instance-id> <your-email> [region]
set -euo pipefail
INSTANCE_ID="$1"; EMAIL="$2"; REGION="${3:-ap-south-1}"

TOPIC_ARN=$(aws sns create-topic --name shopease-alerts --region "$REGION" --query TopicArn --output text)
aws sns subscribe --topic-arn "$TOPIC_ARN" --protocol email --notification-endpoint "$EMAIL" --region "$REGION"
echo "Check your inbox and confirm the SNS subscription."

aws cloudwatch put-metric-alarm --region "$REGION" --alarm-name shopease-high-cpu \
  --namespace AWS/EC2 --metric-name CPUUtilization --dimensions Name=InstanceId,Value="$INSTANCE_ID" \
  --statistic Average --period 300 --evaluation-periods 2 --threshold 80 \
  --comparison-operator GreaterThanThreshold --alarm-actions "$TOPIC_ARN"

aws cloudwatch put-metric-alarm --region "$REGION" --alarm-name shopease-high-memory \
  --namespace ShopEase/EC2 --metric-name mem_used_percent --dimensions Name=InstanceId,Value="$INSTANCE_ID" \
  --statistic Average --period 300 --evaluation-periods 2 --threshold 85 \
  --comparison-operator GreaterThanThreshold --alarm-actions "$TOPIC_ARN"

aws cloudwatch put-metric-alarm --region "$REGION" --alarm-name shopease-instance-down \
  --namespace AWS/EC2 --metric-name StatusCheckFailed --dimensions Name=InstanceId,Value="$INSTANCE_ID" \
  --statistic Maximum --period 60 --evaluation-periods 2 --threshold 1 \
  --comparison-operator GreaterThanOrEqualToThreshold --alarm-actions "$TOPIC_ARN"

aws cloudwatch put-metric-alarm --region "$REGION" --alarm-name shopease-failed-deploy \
  --namespace ShopEase --metric-name FailedDeployments \
  --statistic Sum --period 300 --evaluation-periods 1 --threshold 1 \
  --comparison-operator GreaterThanOrEqualToThreshold --treat-missing-data notBreaching --alarm-actions "$TOPIC_ARN"

echo "Alarms created: shopease-high-cpu, shopease-high-memory, shopease-instance-down, shopease-failed-deploy"
