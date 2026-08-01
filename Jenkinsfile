pipeline {
    agent any

    environment {
        AWS_REGION     = 'ap-south-1'
        ECR_REPO       = '517724590804.dkr.ecr.ap-south-1.amazonaws.com/cicd-demo-app'
        IMAGE_TAG      = "${env.BUILD_NUMBER}"
        MANIFESTS_REPO = 'git@github.com:Archesus/CICD-manifests-repo.git'
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Install & Test') {
            steps {
                sh 'npm ci'
                sh 'npm test'
            }
        }

        stage('Build Docker Image') {
            steps {
                sh "docker build -t ${ECR_REPO}:${IMAGE_TAG} ."
            }
        }

        stage('Push to ECR') {
            steps {
                sh """
                    aws ecr get-login-password --region ${AWS_REGION} | \
                    docker login --username AWS --password-stdin ${ECR_REPO}
                    docker push ${ECR_REPO}:${IMAGE_TAG}
                """
            }
        }

        stage('Update Manifests Repo') {
            steps {
                sshagent(['github-deploy-key']) {
                    sh """
                        rm -rf manifests-repo
                        git clone ${MANIFESTS_REPO} manifests-repo
                        cd manifests-repo
                        sed -i "s|image:.*|image: ${ECR_REPO}:${IMAGE_TAG}|" deployment.yaml
                        git config user.email "jenkins@ci.local"
                        git config user.name "Jenkins CI"
                        git commit -am "Deploy image ${IMAGE_TAG}"
                        git push origin main
                    """
                }
            }
        }
    }
}
