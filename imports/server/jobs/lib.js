import { Meteor } from 'meteor/meteor';
import { Octokit } from 'octokit';
import { appOctokit } from '/imports/server/octokit/lib.js';
import { jobs as jobsCollection } from '/imports/lib/collections/jobs.collection.js';

import { app } from '/server/main.js';

const jobs = {
  async apply(user, number) {
    if (user.profile.applied.includes(number)) {
      throw new Meteor.Error(400, 'Already applied to this position');
    }

    Meteor.users.update({
      _id: user._id
    }, {
      'profile.applied': {
        $addToSet: number
      }
    });

    jobsCollection.update({
      'issue.number': number
    }, {
      $inc: {
        applies: 1
      }
    });

    return true;
  },
  async upsert(user, form) {
    let newTags = app.clone(form.tags);
    let removedTags = [];

    const update = {
      $set: {
        title: form.title,
        owner: user._id,
        'company.login': form.profile.company.login,
        'company.id': form.profile.company.id,
        'company.title': form.profile.title,
        'user.login': user.services.github.username,
        'user.id': user.profile.github.id,
        'user.avatarUrl': user.profile.github.avatarUrl,
        tags: form.tags,
        body: form.description
      }
    };

    const octokit = new Octokit({
      auth: user.services.github.accessToken
    });

    if (!form.issue || !form.isUpdate) {
      try {
        const newIssue = await octokit.rest.issues.create({
          owner: Meteor.settings.public.repo.org,
          repo: Meteor.settings.public.repo.jobs,
          title: form.title,
          body: form.description
        });

        form.issue = {
          number: newIssue.data.number
        };

        update.$set['issue.state'] = 'open';
        update.$set['issue.number'] = newIssue.data.number;
        update.$set['issue.updated_at'] = +new Date(newIssue.data.updated_at);
      } catch (e) {
        console.error('[jobs.upsert] [octokit.rest.issues.create] Error:', e);
        throw new Meteor.Error(500, 'Server error occurred. Please, try again later');
      }
    } else {
      if (form.existingTags && form.existingTags.length > 0) {
        newTags = form.tags.filter(x => !form.existingTags.includes(x));
        removedTags = form.existingTags.filter(x => !form.tags.includes(x));

        if (removedTags.length === 1) {
          // REMOVE SINGLE LABEL
          try {
            await appOctokit.rest.issues.removeLabel({
              owner: Meteor.settings.public.repo.org,
              repo: Meteor.settings.public.repo.jobs,
              issue_number: form.issue.number,
              name: removedTags[0]
            });
          } catch (e) {
            console.error('[jobs.upsert] [octokit.rest.issues.removeLabel] Error:', e);
            throw new Meteor.Error(500, 'Server error occurred. Please, try again later');
          }
        } else if (removedTags.length > 1) {
          // REMOVE ALL LABELS AS THERE IS NO removeLabels METHOD
          // AND WE ARE LIMITED TO 30 REQUEST PER MINUTE
          // SO IT'S CHEAPER TO REMOVE ALL LABELS IN CASE IF ANY WAS REMOVED
          try {
            await appOctokit.rest.issues.removeAllLabels({
              owner: Meteor.settings.public.repo.org,
              repo: Meteor.settings.public.repo.jobs,
              issue_number: form.issue.number
            });
          } catch (e) {
            console.error('[jobs.upsert] [octokit.rest.issues.removeAllLabels] Error:', e);
            throw new Meteor.Error(500, 'Server error occurred. Please, try again later');
          }

          for (const tag of form.existingTags) {
            if (!removedTags.includes(tag)) {
              newTags.push(tag);
            }
          }
        }
      }

      newTags = app.uniq(newTags);

      // UPDATE ISSUE
      try {
        const updatedIssue = await octokit.rest.issues.update({
          owner: Meteor.settings.public.repo.org,
          repo: Meteor.settings.public.repo.jobs,
          issue_number: form.issue.number,
          title: form.title,
          state: 'open', // <-- REOPEN IF CLOSED
          body: form.description
        });

        update.$set['issue.state'] = 'open';
        update.$set['issue.number'] = form.issue.number;
        update.$set['issue.updated_at'] = +new Date(updatedIssue.data?.updated_at || 0);
      } catch (e) {
        console.error('[jobs.upsert] [octokit.rest.issues.update] Error:', e);
        throw new Meteor.Error(e.status || 500, 'Server error occurred. Please, try again later');
      }
    }

    if (newTags && newTags.length) {
      // ADD NEW LABELS
      try {
        await appOctokit.rest.issues.addLabels({
          owner: Meteor.settings.public.repo.org,
          repo: Meteor.settings.public.repo.jobs,
          issue_number: form.issue.number,
          labels: newTags
        });
      } catch (e) {
        console.error('[jobs.upsert] [appOctokit.rest.issues.addLabels] Error:', e);
        throw new Meteor.Error(500, 'Server error occurred. Please, try again later');
      }
    }

    update.$set.location = form.location;
    update.$set.isRemote = form.isRemote;
    update.$set.availability = form.availability;
    update.$set.category = form.category;
    update.$set.skills = form.skills;

    jobsCollection.upsert({
      'issue.number': form.issue.number,
    }, update);

    Meteor.users.update(user._id, {
      $addToSet: {
        'profile.jobs': form.issue.number
      }
    });

    return form.issue.number;
  },
  async close(user, number) {
    const octokit = new Octokit({
      auth: user.services.github.accessToken
    });

    try {
      await octokit.rest.issues.update({
        owner: Meteor.settings.public.repo.org,
        repo: Meteor.settings.public.repo.jobs,
        issue_number: number,
        state: 'closed'
      });
    } catch (e) {
      console.error('[jobs.close] [octokit.rest.issues.update] Error:', e);
      throw new Meteor.Error(e.status || 500, 'Server error occurred. Please, try again later');
    }

    jobsCollection.update({ 'issue.number': number }, {
      $set: {
        'issue.state': 'closed'
      }
    });

    return true;
  },
  async closeAll(user) {
    const octokit = new Octokit({
      auth: user.services.github.accessToken
    });

    try {
      const userJobs = jobsCollection.find({
        owner: user._id,
        'issue.state': 'open'
      }, {
        fields: {
          'issue.number': 1
        }
      }).fetch();

      for (const job of userJobs) {
        await octokit.rest.issues.update({
          owner: Meteor.settings.public.repo.org,
          repo: Meteor.settings.public.repo.jobs,
          issue_number: job.issue.number,
          state: 'closed'
        });
      }

      jobsCollection.update({
        owner: user._id,
        'issue.state': 'open'
      }, {
        $set: {
          'issue.state': 'closed'
        }
      });
    } catch (e) {
      console.error('[jobs.closeAll] [octokit.rest.issues.update] Error:', e);
      throw new Meteor.Error(e.status || 500, 'Server error occurred. Please, try again later');
    }


    return true;
  },
  async reopen(user, number) {
    const octokit = new Octokit({
      auth: user.services.github.accessToken
    });

    try {
      await octokit.rest.issues.update({
        owner: Meteor.settings.public.repo.org,
        repo: Meteor.settings.public.repo.jobs,
        issue_number: number,
        state: 'open'
      });
    } catch (e) {
      console.error('[jobs.reopen] [octokit.rest.issues.update] Error:', e);
      throw new Meteor.Error(e.status || 500, 'Server error occurred. Please, try again later');
    }

    jobsCollection.update({ 'issue.number': number }, {
      $set: {
        'issue.state': 'open'
      }
    });

    return true;
  }
};

export { jobs };
