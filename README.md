# ShopEase — End-to-End DevOps Project on AWS

A working e-commerce store (product catalogue, search, filters, cart, checkout) with a **fully automated CI/CD pipeline**:

```
 You edit UI ──git push──► GitHub ──webhook──► Jenkins (EC2)
                                                  │
     ┌────────────────────────────────────────────┘
     ▼
  1. Checkout      2. Unit tests (in Docker)     3. Docker build (image tag = build #)
  4. Import image into k3s   5. Rolling deploy on Kubernetes (zero downtime)
  6. Smoke test live site    7. Artifacts → S3   8. Deploy metric → CloudWatch
     ▼
 http://<ELASTIC-IP>/   ← updated site live in ~1–2 minutes
```

| Tool | What it does here |
|---|---|
| **AWS EC2** | One Ubuntu server runs Jenkins + Docker + Kubernetes (k3s) |
| **Elastic IP** | Static public IP — never changes, even after stop/start |
| **AWS S3** | Stores every build's artifact bundle + `build-info.json` (versioned) |
| **AWS CloudWatch** | App logs, Jenkins logs, syslog, memory/disk metrics, deploy metrics, alarms |
| **IAM Role** | Gives EC2 access to S3/CloudWatch — **no AWS keys stored anywhere** |
| **GitHub Webhook** | Triggers Jenkins instantly on every `git push` |
| **Jenkins** | Pipeline defined in `Jenkinsfile` (pipeline-as-code) |
| **Docker** | Multi-stage build: test stage + small production image |
| **Kubernetes (k3s)** | 2 replicas, rolling updates, health probes, autoscaling (HPA), Ingress on port 80, auto-rollback on failure |

## Project structure

```
shopease-devops/
├── app/                      # Node.js + Express e-commerce app
│   ├── server.js             # API: products, orders, /health, /api/version
│   ├── data/products.json    # product catalogue (edit me!)
│   ├── public/               # UI: index.html, styles.css, app.js
│   └── test/api.test.js      # unit tests (run in the pipeline)
├── Dockerfile                # multi-stage: test → production
├── docker-compose.yml        # run locally
├── Jenkinsfile               # the CI/CD pipeline
├── k8s/                      # namespace, deployment, service, ingress, hpa
├── scripts/setup-ec2.sh      # one-shot server setup (Docker, Jenkins, k3s, AWS CLI, CloudWatch)
├── cloudwatch/amazon-cloudwatch-agent.json
└── aws/
    ├── ec2-role-policy.json  # S3 permissions for the EC2 role
    └── cloudwatch-alarm.sh   # optional alarms + email alerts
```

---

## PART 0 — Run it locally first (optional, 2 minutes)

```bash
cd shopease-devops
docker compose up --build        # → http://localhost:3000
# or without Docker:
cd app && npm install && npm test && npm start
```

---

## PART 1 — AWS Console setup (do these in order)

> **⚠️ About the root user:** Use the root user **only** to create an IAM admin user, then log out and do everything else as that IAM user. Root has unlimited power over billing and the account, and leaked root credentials can't be restricted. It takes 3 minutes:
> 1. Root login → top-right account menu → **Security credentials** → **Assign MFA** (use Google Authenticator).
> 2. **IAM → Users → Create user** → name `admin` → tick *Provide user access to the AWS Management Console* → set a password.
> 3. Permissions: **Attach policies directly → `AdministratorAccess`** → Create.
> 4. Note the **console sign-in URL** shown on the IAM dashboard, log out of root, and log in as `admin`.
> 5. Set up a **billing alert**: Billing → Budgets → Create budget → *Monthly cost budget*, e.g. $10, with your email.

**Region:** pick **Asia Pacific (Mumbai) `ap-south-1`** (top-right) and use it for everything below.

### Step 1 — Create the S3 bucket
1. **S3 → Create bucket**
2. Name: globally unique, e.g. `shopease-artifacts-<yourname>-2026` (lowercase, no spaces) — **write it down**
3. Region: `ap-south-1`
4. Keep **Block all public access = ON**
5. **Bucket Versioning → Enable** → Create bucket

### Step 2 — Create the IAM Role for EC2
1. **IAM → Roles → Create role**
2. Trusted entity: **AWS service** → Use case: **EC2** → Next
3. Search and tick **`CloudWatchAgentServerPolicy`** → Next
4. Role name: `shopease-ec2-role` → Create role
5. Open the role → **Add permissions → Create inline policy → JSON** → paste the contents of `aws/ec2-role-policy.json`, replacing **both** `REPLACE-WITH-YOUR-BUCKET-NAME` with your bucket name → Next → name `shopease-s3-access` → Create policy
6. *(Optional, for the alarms script)* also attach `CloudWatchFullAccessV2` and `AmazonSNSFullAccess`

### Step 3 — Create a key pair
**EC2 → Key Pairs → Create key pair** → name `shopease-key`, type RSA, format `.pem` (Mac/Linux/Win10+ ssh) or `.ppk` (PuTTY) → it downloads. Keep it safe.

### Step 4 — Create a Security Group
**EC2 → Security Groups → Create security group** → name `shopease-sg`. Inbound rules:

| Type | Port | Source | Why |
|---|---|---|---|
| SSH | 22 | **My IP** | your SSH access only |
| HTTP | 80 | 0.0.0.0/0 | the website |
| Custom TCP | 8080 | 0.0.0.0/0 | Jenkins UI + GitHub webhook |

(Outbound: leave "All traffic".) *Tip: for tighter security you can restrict 8080 to My IP + GitHub's hook IP ranges from https://api.github.com/meta.*

### Step 5 — Launch the EC2 instance
**EC2 → Instances → Launch instances**
- Name: `shopease-server`
- AMI: **Ubuntu Server 24.04 LTS** (64-bit x86)
- Instance type: **`t3.medium`** (2 vCPU, 4 GB RAM) — *t2.micro/t3.micro (free tier) is too small for Jenkins + Kubernetes and will freeze.* Costs roughly $0.045/hour; **stop it when not in use**.
- Key pair: `shopease-key`
- Network settings → **Select existing security group** → `shopease-sg`
- Storage: **25 GiB gp3**
- **Advanced details → IAM instance profile → `shopease-ec2-role`**
- Launch

### Step 6 — Allocate a static IP (Elastic IP)
1. **EC2 → Elastic IPs → Allocate Elastic IP address** → Allocate
2. Select it → **Actions → Associate Elastic IP address** → Instance: `shopease-server` → Associate
3. This is now your permanent IP. **Use this IP everywhere below.** It stays the same after reboots and stop/start.

> An Elastic IP is free while attached to a running instance; AWS charges a small hourly fee while the instance is stopped or if the IP is unattached. If you delete the project, **release** the Elastic IP.

---

## PART 2 — Push the code to GitHub

1. Create a new GitHub repository, e.g. `shopease-devops` (public is easiest; private works too — see Part 4 note).
2. On your computer, unzip this project and run:
```bash
cd shopease-devops
git init
git add .
git commit -m "Initial ShopEase DevOps project"
git branch -M main
git remote add origin https://github.com/<your-username>/shopease-devops.git
git push -u origin main
```

---

## PART 3 — Set up the EC2 server (one command)

```bash
# from your computer (Windows: use PowerShell / Git Bash)
chmod 400 shopease-key.pem
ssh -i shopease-key.pem ubuntu@<ELASTIC-IP>

# on the server
git clone https://github.com/<your-username>/shopease-devops.git
cd shopease-devops
sudo bash scripts/setup-ec2.sh <your-bucket-name> ap-south-1
```

It takes ~5–8 minutes and installs Docker, Jenkins, k3s Kubernetes, AWS CLI, CloudWatch agent and swap. At the end it prints the **Jenkins URL** and the **initial admin password** — copy it.

Check it worked:
```bash
sudo k3s kubectl get nodes          # STATUS = Ready
sudo systemctl status jenkins       # active (running)
aws s3 ls s3://<your-bucket-name>   # no error = IAM role works
```

---

## PART 4 — Configure Jenkins (one time, ~5 minutes)

1. Open `http://<ELASTIC-IP>:8080` → paste the initial admin password.
2. **Install suggested plugins** (includes Git, GitHub, Pipeline, Timestamper).
3. Create your admin user → Jenkins URL: `http://<ELASTIC-IP>:8080/` → Save and Finish.
4. **New Item** → name `shopease-pipeline` → **Pipeline** → OK
5. **Triggers:** tick **GitHub hook trigger for GITScm polling**
6. **Pipeline:**
   - Definition: **Pipeline script from SCM**
   - SCM: **Git**
   - Repository URL: `https://github.com/<your-username>/shopease-devops.git`
   - Credentials: *none* for a public repo. *Private repo:* Add → Jenkins → Kind **Username with password** → username = GitHub username, password = a GitHub **Personal Access Token** (Settings → Developer settings → Fine-grained token, read access to *Contents* for this repo).
   - Branch Specifier: `*/main`
   - Script Path: `Jenkinsfile`
7. **Save** → click **Build Now** once (this first manual run registers the webhook trigger).
8. When it's green, open **`http://<ELASTIC-IP>/`** — your store is live! The footer shows `build #1 · pod shopease-xxxx`.

---

## PART 5 — Connect the GitHub Webhook (the "one-click git push" automation)

1. GitHub repo → **Settings → Webhooks → Add webhook**
2. Payload URL: **`http://<ELASTIC-IP>:8080/github-webhook/`** (the trailing `/` matters)
3. Content type: `application/json`
4. Events: **Just the push event** → Active → **Add webhook**
5. Refresh — you should see a green ✔ next to the latest delivery.

### 🎉 Test the full automation
```bash
# on your computer: change something visible
#  e.g. app/public/index.html → edit the announcement bar text
#  or   app/public/styles.css → change --brand: #4f46e5 to #16a34a (green)
#  or   app/data/products.json → change a price
git add . && git commit -m "Change UI" && git push
```
Jenkins starts automatically → ~1–2 minutes later refresh `http://<ELASTIC-IP>/` (Ctrl+F5) and the change is live, with the footer showing the new build number. No manual steps.

**Auto-rollback demo:** break a test (e.g. change `2499 * 2` in `app/test/api.test.js`) and push — the pipeline fails at *Unit tests* and the live site keeps running the last good version.

---

## PART 6 — CloudWatch & S3 (see it working)

- **CloudWatch → Log groups:** `/shopease/app` (JSON request + order logs from the pods), `/shopease/jenkins`, `/shopease/system`
- **CloudWatch → Metrics → All metrics:** `ShopEase/EC2` (memory, disk, CPU, swap) and `ShopEase` (`SuccessfulDeployments`, `FailedDeployments`)
- **Optional alarms with email:**
  ```bash
  # on EC2 (needs the optional permissions from Step 2.6)
  bash aws/cloudwatch-alarm.sh <instance-id> <your-email> ap-south-1
  ```
- **S3 → your bucket:** `builds/<N>/shopease-<N>.tar.gz`, `builds/<N>/build-info.json`, and `latest/build-info.json`

---

## Useful commands (on the EC2)

```bash
kubectl -n shopease get pods,svc,ingress,hpa          # everything running
kubectl -n shopease logs -l app=shopease --tail=50    # app logs
kubectl -n shopease rollout history deployment/shopease
kubectl -n shopease rollout undo deployment/shopease  # manual rollback
kubectl -n shopease scale deployment/shopease --replicas=3
sudo journalctl -u jenkins -f                         # Jenkins logs
df -h && free -h                                      # disk & memory
```
(If `kubectl` complains about permissions as `ubuntu`, run `export KUBECONFIG=/etc/rancher/k3s/k3s.yaml`.)

## Troubleshooting

| Problem | Fix |
|---|---|
| Webhook shows red ✗ / timeout | Port 8080 open in `shopease-sg`? URL ends with `/github-webhook/`? Jenkins running? |
| Push doesn't start a build | Run **Build Now** once manually; confirm "GitHub hook trigger" is ticked |
| `permission denied ... docker.sock` in Jenkins | `sudo usermod -aG docker jenkins && sudo systemctl restart jenkins` |
| `sudo: a password is required` at "Load image" stage | Re-run `scripts/setup-ec2.sh` (creates `/etc/sudoers.d/jenkins-k3s`) |
| Site shows `404 page not found` | First pipeline hasn't finished yet, or check `kubectl -n shopease get ingress,pods` |
| S3 stage fails `AccessDenied` | IAM role attached to the instance? Bucket name in policy matches exactly? |
| Old version still showing | Hard refresh (Ctrl+F5); check footer build number |
| Server freezes | Instance is too small — use t3.medium or larger |
| Jenkins apt key error | The Jenkins signing key rotates every few years; get the current key URL from https://www.jenkins.io/doc/book/installing/linux/ and update step 4 of `setup-ec2.sh` |

## Cost control / cleanup
Stop the instance when you're not using it (the Elastic IP keeps your IP). To delete everything: terminate the instance → **release the Elastic IP** → empty and delete the S3 bucket → delete CloudWatch log groups → delete the IAM role.

## Next steps (to extend the project)
- Add a domain (Route 53) + free HTTPS (cert-manager / Let's Encrypt on Traefik)
- Push images to Amazon ECR instead of local import
- Move to Amazon EKS with Terraform for multi-node Kubernetes
- Add a database (Amazon RDS / DynamoDB) for persistent orders
- Slack/email notifications from Jenkins
