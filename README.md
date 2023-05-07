# To install dependencies

Use Github Codespaces to open this repo, it will come with pulumi, node, yarn, etc. that you need with the correct versions.

yarn

# To deploy

yarn workspace @napali/main exec pulumi up --stack prod

# To typecheck

yarn tsc --build