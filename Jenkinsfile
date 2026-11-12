// =====================================================================
//  ShopEase CI/CD pipeline
//  git push -> GitHub webhook -> Jenkins -> test -> Docker build ->
//  import into k3s -> rolling deploy on Kubernetes -> smoke test ->
//  artifacts to S3 -> deployment metric to CloudWatch
//
//  S3 bucket + AWS region come from /etc/shopease/pipeline.env, which
//  scripts/setup-ec2.sh writes on the EC2 server. No secrets in Git:
//  AWS access comes from the EC2 IAM role.
// =====================================================================
pipeline {
    agent any

    triggers {
        githubPush()          // fired by the GitHub webhook on every push
    }

    options {
        timestamps()
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '15'))
        timeout(time: 20, unit: 'MINUTES')
    }

    environment {
        APP_NAME   = 'shopease'
        NAMESPACE  = 'shopease'
        IMAGE_TAG  = "${env.BUILD_NUMBER}"
        IMAGE      = "shopease:${env.BUILD_NUMBER}"
        KUBECONFIG = '/var/lib/jenkins/.kube/config'
        ENV_FILE   = '/etc/shopease/pipeline.env'
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
                sh 'git log -1 --pretty="Commit %h by %an: %s"'
            }
        }

        stage('Unit tests') {
            steps {
                // Runs "npm test" inside the Dockerfile's test stage - no Node needed on the server
                sh 'docker build --target test -t ${APP_NAME}:test-${IMAGE_TAG} .'
            }
        }

        stage('Build Docker image') {
            steps {
                sh 'docker build --target production --build-arg BUILD_NUMBER=${IMAGE_TAG} -t ${IMAGE} .'
            }
        }

        stage('Load image into Kubernetes') {
            steps {
                // k3s uses containerd; import the image directly (no registry required)
                sh 'docker save ${IMAGE} | sudo /usr/local/bin/k3s ctr images import -'
            }
        }

        stage('Deploy to Kubernetes') {
            steps {
                sh '''
                    kubectl apply -f k8s/namespace.yaml
                    sed "s/__TAG__/${IMAGE_TAG}/g" k8s/deployment.yaml | kubectl apply -f -
                    kubectl apply -f k8s/service.yaml -f k8s/ingress.yaml -f k8s/hpa.yaml
                    kubectl -n ${NAMESPACE} annotate deployment/${APP_NAME} \
                        kubernetes.io/change-cause="Jenkins build #${IMAGE_TAG}" --overwrite
                    kubectl -n ${NAMESPACE} rollout status deployment/${APP_NAME} --timeout=180s
                    kubectl -n ${NAMESPACE} get pods -o wide
                '''
            }
            post {
                failure {
                    echo 'Deploy failed - rolling back to the previous version'
                    sh 'kubectl -n ${NAMESPACE} rollout undo deployment/${APP_NAME} || true'
                }
            }
        }

        stage('Smoke test') {
            steps {
                // Wait until the new build answers 3 times in a row (old pods may still be shutting down)
                sh '''
                    sleep 10
                    OK=0
                    for i in $(seq 1 30); do
                      BUILD=$(curl -fsS http://localhost/api/version | sed -n 's/.*"build":"\\([^"]*\\)".*/\\1/p') || true
                      if [ "$BUILD" = "${IMAGE_TAG}" ] && curl -fsS -o /dev/null http://localhost/health; then
                        OK=$((OK+1))
                        echo "Check $OK/3 passed: live site is serving build #${BUILD}"
                        if [ "$OK" -ge 3 ]; then exit 0; fi
                      else
                        OK=0
                        echo "Waiting for build #${IMAGE_TAG} (currently: ${BUILD:-none})..."
                      fi
                      sleep 3
                    done
                    echo "Smoke test failed"; exit 1
                '''
            }
            post {
                failure {
                    echo 'Smoke test failed - rolling back to the previous version'
                    sh 'kubectl -n ${NAMESPACE} rollout undo deployment/${APP_NAME} || true'
                }
            }
        }

        stage('Publish to S3 & CloudWatch') {
            steps {
                sh '''
                    if [ ! -f "$ENV_FILE" ]; then echo "No $ENV_FILE - skipping S3/CloudWatch"; exit 0; fi
                    . "$ENV_FILE"

                    COMMIT=$(git rev-parse --short HEAD)
                    cat > build-info.json <<EOF
{ "build": "${IMAGE_TAG}", "commit": "${COMMIT}", "image": "${IMAGE}", "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)" }
EOF
                    tar -czf ${APP_NAME}-${IMAGE_TAG}.tar.gz app/public app/data k8s build-info.json

                    aws s3 cp ${APP_NAME}-${IMAGE_TAG}.tar.gz s3://${S3_BUCKET}/builds/${IMAGE_TAG}/ --region ${AWS_REGION}
                    aws s3 cp build-info.json s3://${S3_BUCKET}/builds/${IMAGE_TAG}/ --region ${AWS_REGION}
                    aws s3 cp build-info.json s3://${S3_BUCKET}/latest/build-info.json --region ${AWS_REGION}

                    aws cloudwatch put-metric-data --region ${AWS_REGION} \
                        --namespace ShopEase --metric-name SuccessfulDeployments --value 1 --unit Count
                '''
            }
        }
    }

    post {
        success {
            echo "✅ ShopEase build #${env.BUILD_NUMBER} is live."
        }
        failure {
            echo "❌ Build #${env.BUILD_NUMBER} failed - the live site keeps running the last good version."
            sh '''
                if [ -f "$ENV_FILE" ]; then
                  . "$ENV_FILE"
                  aws cloudwatch put-metric-data --region ${AWS_REGION} \
                    --namespace ShopEase --metric-name FailedDeployments --value 1 --unit Count || true
                fi
            '''
        }
        always {
            // keep the disk clean: drop the test image, dangling layers and all but the last 3 app images
            sh '''
                docker image rm ${APP_NAME}:test-${IMAGE_TAG} >/dev/null 2>&1 || true
                docker images ${APP_NAME} --format '{{.Tag}}' | grep -E '^[0-9]+$' | sort -n | head -n -3 \
                    | xargs -r -I{} docker image rm ${APP_NAME}:{} >/dev/null 2>&1 || true
                docker image prune -f >/dev/null 2>&1 || true
            '''
        }
    }
}