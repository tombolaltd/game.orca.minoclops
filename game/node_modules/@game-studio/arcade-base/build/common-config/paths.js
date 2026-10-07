const path = require('path');

const context = path.resolve(__dirname, '../../');
const baseDistributionDirectory = path.resolve(context, './dist');

module.exports = {
    context: context,
    baseDistributionDirectory: baseDistributionDirectory
}