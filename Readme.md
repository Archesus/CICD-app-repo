# CICD Demo App

A minimal Node.js app used to demonstrate a full GitOps-style CI/CD pipeline on AWS: **GitHub → Jenkins (EC2) → ECR → ArgoCD → EKS**.

# Images

<img src="/public/Screenshot 2026-08-01 171455.png" alt="argocd ui" width="100%" height="100%">
<img src="/public/Screenshot 2026-08-01 171508.png" alt="ecr ui" width="100%" height="100%">
<img src="/public/Screenshot 2026-08-01 171542.png" alt="jenkins pipeline" width="100%" height="100%">
<img src="/public/Screenshot 2026-08-01 171621.png" alt="k8s pods" width="100%" height="100%">


## Architecture

```
git push (app-repo)
      │
      ▼ (GitHub webhook)
Jenkins (EC2)
  ├─ npm ci / npm test
  ├─ docker build
  ├─ docker push → ECR
  └─ bump image tag → git push (manifests-repo)
                              │
                              ▼ (auto-sync)
                        ArgoCD (in-cluster)
                              │
                              ▼
                          EKS Deployment
```

Two repositories are used by design:

| Repo | Purpose |
|---|---|
| `CICD-app-repo` (this repo) | Application source, `Dockerfile`, `Jenkinsfile` |
| `CICD-manifests-repo` | Kubernetes manifests (`deployment.yaml`, `service.yaml`) watched by ArgoCD |

Jenkins never authenticates to the Kubernetes cluster directly. It only pushes an image to ECR and commits an image-tag bump to the manifests repo. ArgoCD, running inside the cluster, pulls that change and reconciles the cluster state. This pull-based (GitOps) pattern means no cluster credentials ever live on the build server.

## Stack

- **App:** Node.js (plain HTTP server, no framework — placeholder for demo purposes)
- **Container Registry:** Amazon ECR
- **Cluster:** Amazon EKS (`ap-south-1`), provisioned via `eksctl`
- **CI:** Jenkins on a self-managed EC2 instance
- **CD:** ArgoCD (in-cluster, automated sync)
- **Source control:** GitHub (two repos, PAT-based auth from Jenkins)

## Repository Layout

```
.
├── Dockerfile
├── Jenkinsfile
├── package.json
├── package-lock.json
├── server.js
└── README.md
```

## Prerequisites

- AWS CLI configured with access to `ap-south-1`
- `kubectl`, `eksctl`, `argocd` CLI installed locally
- An EKS cluster with ArgoCD installed (see [Cluster & ArgoCD Setup](#cluster--argocd-setup))
- A Jenkins server on EC2 with Docker, Node.js, and required plugins (see [Jenkins Setup](#jenkins-setup))
- An ECR repository created for this app
- A separate GitHub repo (`CICD-manifests-repo`) containing the Kubernetes manifests

## Cluster & ArgoCD Setup

```bash
eksctl create cluster \
  --name cicd-demo-cluster \
  --region ap-south-1 \
  --version 1.30 \
  --nodegroup-name standard-workers \
  --node-type t3.medium \
  --nodes 2 \
  --managed

kubectl create namespace argocd
kubectl apply -n argocd --server-side --force-conflicts \
  -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
```

> Use `--server-side --force-conflicts` when applying — ArgoCD's CRDs are large enough that a standard `kubectl apply` can exceed Kubernetes' 262KB annotation limit on repeated applies.

Retrieve the initial admin password:
```bash
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" | base64 -d
```

Access the UI over **`https://`** (not `http://` — ArgoCD serves TLS by default with a self-signed cert).

### Register the Application

```bash
argocd login <ARGOCD-HOSTNAME> --username admin --password <PASSWORD> --insecure

argocd app create cicd-demo-app \
  --repo https://github.com/Archesus/CICD-manifests-repo.git \
  --path . \
  --dest-server https://kubernetes.default.svc \
  --dest-namespace default \
  --sync-policy automated
```

`--sync-policy automated` means ArgoCD applies changes to the manifests repo without manual intervention — this is what closes the CD loop.

## Jenkins Setup

### 1. EC2 instance

- Ubuntu instance with an IAM role attached (no static AWS credentials) scoped to push to the specific ECR repo only.
- Security group: port 22 restricted to admin IP; port 8080 open to GitHub's IP ranges (or `0.0.0.0/0` for quick testing) so webhook deliveries can reach it.

### 2. Install dependencies on the instance

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y fontconfig openjdk-17-jre docker.io nodejs npm
sudo usermod -aG docker jenkins
sudo systemctl restart jenkins
```

Jenkins install itself follows the standard Debian package instructions from [jenkins.io](https://www.jenkins.io/doc/book/installing/linux/).

### 3. Jenkins plugins

- Docker Pipeline
- GitHub Integration / GitHub Webhook Trigger
- Pipeline: AWS Steps (optional)

### 4. Credentials

Configured under **Manage Jenkins → Credentials**:

| ID | Type | Purpose |
|---|---|---|
| `github-pat` | Username with password | GitHub PAT (fine-grained, scoped to `CICD-app-repo` + `CICD-manifests-repo`, Contents: Read & Write) used to clone `app-repo` and push updates to `manifests-repo` |

No AWS credentials are stored in Jenkins — ECR authentication uses the EC2 instance's attached IAM role via `aws ecr get-login-password`.

### 5. Job configuration

- Type: **Pipeline**
- Definition: **Pipeline script from SCM** → Git → this repo's URL, credentials `github-pat`, branch `*/main`, script path `Jenkinsfile`
- Build Triggers: **GitHub hook trigger for GITScm polling** checked

### 6. GitHub webhook (on this repo)

**Settings → Webhooks → Add webhook**
- Payload URL: `http://<jenkins-public-ip>:8080/github-webhook/` (note the trailing slash)
- Content type: `application/json`
- Events: just the push event

## Pipeline Stages

Defined in [`Jenkinsfile`](./Jenkinsfile):

1. **Checkout** — pulls this repo
2. **Install & Test** — `npm ci`, `npm test`
3. **Build Docker Image** — `docker build`, tagged with the Jenkins build number
4. **Push to ECR** — authenticates via the instance's IAM role, pushes the image
5. **Update Manifests Repo** — clones `CICD-manifests-repo` using the `github-pat` credential, bumps the image tag in `deployment.yaml`, commits, and pushes

Once step 5 lands, ArgoCD (polling or via its own webhook) detects the change in `CICD-manifests-repo` and rolls out the new image to EKS automatically.

## Testing the Full Loop

1. Make a change in this repo and `git push`.
2. GitHub webhook fires → Jenkins job starts automatically (check **Recent Deliveries** on the GitHub webhook page to confirm delivery).
3. Jenkins builds, tests, pushes the image, and updates the manifests repo.
4. ArgoCD syncs; verify with:
   ```bash
   kubectl rollout status deployment/cicd-demo-app
   kubectl get pods -w
   ```

## Cost Management

- **EKS control plane** bills (~$0.10/hr) regardless of node count — delete the cluster entirely for extended downtime rather than just scaling nodes to 0.
- **Scale nodes to 0** for short pauses within a session:
  ```bash
  eksctl scale nodegroup --cluster cicd-demo-cluster --name standard-workers --nodes 0 --region ap-south-1
  ```
- **Avoid leaving ArgoCD's Service as `LoadBalancer`** when not actively demoing the UI — switch to `ClusterIP` and use `kubectl port-forward` instead to avoid ELB charges.
- **Stop (don't terminate) the Jenkins EC2 instance** between sessions to preserve installed config while paying only for EBS storage, not compute.

## Security Notes

- Jenkins never holds Kubernetes credentials — deployment is entirely pull-based via ArgoCD.
- IAM role attached to the Jenkins EC2 instance is scoped to a single ECR repository ARN, not account-wide access.
- GitHub PAT is fine-grained and scoped only to the two repos Jenkins needs, with Contents: Read & Write — no broader account access.
- ArgoCD's initial admin password should be rotated after first login (`argocd account update-password`).