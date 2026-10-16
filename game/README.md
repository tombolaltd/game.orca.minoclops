## Minoclops Build Setup

``` bash
# install dependencies
npm install

# serve with hot reload.
npm run serve

# serve with country asset overrides (region to be replaced with specifc region, e.g. npm run serve --country=it)
npm run serve --country=region

# build for production with minification
npm run build

# perform lint checks throughout the game folder, without fixing them
npm run lint

# perform lint checks throughout the game folder, and fix any issues that can be automatically fixed
npm run lint-fix

# correct code style inconsistencies
npm run format-fix

# check for style inconsistencies - only really needed for the pre-commit hook
npm run format

# setup a pre-commit hook to prevent commiting incorrectly styled code
npm run prepare
```

For a detailed explanation on how things work, check out the [guide](http://vuejs-templates.github.io/webpack/) and [docs for vue-loader](http://vuejs.github.io/vue-loader).
